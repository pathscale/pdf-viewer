use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pdf_toolkit::core::Limits;
use pdf_toolkit::edit::Editor;
use pdf_toolkit::text::annots::{Annotation, page_annotations};
use pdf_toolkit::write::annot::{Annot, AnnotKind};
use serde_json::{Value, json};

use crate::commands::{self, OpenDoc};

const MAX_HISTORY_OPS: usize = 1024;
const MAX_HISTORY_BYTES: usize = 256 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_QUADS: usize = 4096;
const MAX_INK_PATHS: usize = 4096;
const MAX_INK_POINTS: usize = 65_536;

pub(crate) struct History {
    original: Arc<[u8]>,
    path: PathBuf,
    ops: Vec<EditOp>,
    undone: Vec<EditOp>,
}

impl History {
    pub(crate) fn new(original: Arc<[u8]>, path: PathBuf) -> Self {
        Self {
            original,
            path,
            ops: Vec::new(),
            undone: Vec::new(),
        }
    }
}

enum EditOp {
    Annotate {
        page: u32,
        annot: Annot,
    },
    RemoveAnnotation {
        page: u32,
        index: usize,
    },
    Rotate {
        page: u32,
        turns: i32,
    },
    Delete {
        page: u32,
    },
    Move {
        from: u32,
        to: u32,
    },
    Insert {
        source: Arc<[u8]>,
        pages: Vec<u32>,
        at: u32,
    },
    SetInfo {
        key: &'static str,
        text: String,
    },
}

impl EditOp {
    fn apply(&self, editor: &mut Editor) -> Result<(), String> {
        let result = match self {
            Self::Annotate { page, annot } => editor.add_annotation(*page, annot).map(|_| ()),
            Self::RemoveAnnotation { page, index } => editor.remove_annotation(*page, *index),
            Self::Rotate { page, turns } => editor.rotate_page(*page, *turns),
            Self::Delete { page } => editor.delete_page(*page),
            Self::Move { from, to } => editor.move_page(*from, *to),
            Self::Insert { source, pages, at } => {
                editor.import_pages(Arc::clone(source), pages, *at)
            }
            Self::SetInfo { key, text } => {
                editor.set_info(key, text);
                Ok(())
            }
        };
        result.map_err(|error| format!("{error:?}"))
    }

    fn retained_bytes(&self) -> usize {
        let extra = match self {
            Self::Annotate { annot, .. } => {
                let geometry = match &annot.kind {
                    AnnotKind::Highlight { quads } => {
                        quads.len().saturating_mul(std::mem::size_of::<[f32; 8]>())
                    }
                    AnnotKind::Ink { paths, .. } => paths.iter().fold(
                        paths
                            .len()
                            .saturating_mul(std::mem::size_of::<Vec<[f32; 2]>>()),
                        |total, path| {
                            total.saturating_add(
                                path.len().saturating_mul(std::mem::size_of::<[f32; 2]>()),
                            )
                        },
                    ),
                    AnnotKind::FreeText { text, .. } => text.len(),
                    _ => 0,
                };
                geometry
                    .saturating_add(annot.contents.as_ref().map_or(0, String::len))
                    .saturating_add(annot.author.as_ref().map_or(0, String::len))
            }
            Self::Insert { source, pages, .. } => source
                .len()
                .saturating_add(pages.len().saturating_mul(std::mem::size_of::<u32>())),
            Self::SetInfo { text, .. } => text.len(),
            _ => 0,
        };
        std::mem::size_of::<Self>().saturating_add(extra)
    }
}

fn refusal(kind: &str, requested: usize, maximum: usize) -> String {
    format!("refused: {kind}, requested={requested}, maximum={maximum}")
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
}

fn check_text(text: &str, key: &str, maximum: usize) -> Result<(), String> {
    if text.len() > maximum {
        return Err(refusal(key, text.len(), maximum));
    }
    Ok(())
}

fn optional_text(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            check_text(text, key, MAX_TEXT_BYTES)?;
            Ok(Some(text.clone()))
        }
        Some(_) => Err(format!("{key} must be a string or null")),
    }
}

fn usize_arg(args: &Value, key: &str) -> Result<usize, String> {
    let value = args
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{key} must be a nonnegative integer"))?;
    usize::try_from(value).map_err(|_| format!("{key} is out of range"))
}

fn page_arg(doc: &OpenDoc, args: &Value, key: &str, allow_end: bool) -> Result<u32, String> {
    let index = usize_arg(args, key)?;
    if index > doc.pages.len() || (!allow_end && index == doc.pages.len()) {
        return Err(format!("{key} is out of range"));
    }
    u32::try_from(index).map_err(|_| format!("{key} is out of range"))
}

fn number(value: &Value, key: &str) -> Result<f32, String> {
    let value = value
        .as_f64()
        .ok_or_else(|| format!("{key} must be a number"))?;
    let converted = value as f32;
    if !value.is_finite() || !converted.is_finite() {
        return Err(format!("{key} must be finite"));
    }
    Ok(converted)
}

fn optional_number(args: &Value, key: &str, default: f32) -> Result<f32, String> {
    match args.get(key) {
        Some(value) => number(value, key),
        None => Ok(default),
    }
}

fn fixed<const N: usize>(value: &Value, key: &str) -> Result<[f32; N], String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    if values.len() != N {
        return Err(format!("{key} must contain {N} numbers"));
    }
    let mut result = [0.0; N];
    for (destination, value) in result.iter_mut().zip(values) {
        *destination = number(value, key)?;
    }
    Ok(result)
}

fn array<'a>(value: &'a Value, key: &str, maximum: usize) -> Result<&'a [Value], String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    if values.len() > maximum {
        return Err(refusal(key, values.len(), maximum));
    }
    if values.is_empty() {
        return Err(format!("{key} must not be empty"));
    }
    Ok(values)
}

fn parse_quads(value: &Value) -> Result<Vec<[f32; 8]>, String> {
    array(value, "quads", MAX_QUADS)?
        .iter()
        .map(|quad| fixed(quad, "quad"))
        .collect()
}

fn highlight_rect(quads: &[[f32; 8]]) -> Result<[f32; 4], String> {
    let mut rect = [
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    for quad in quads {
        // QuadPoints use top-left, top-right, bottom-left, bottom-right order.
        // Walk the perimeter when checking the area.
        let points = [
            [quad[0], quad[1]],
            [quad[2], quad[3]],
            [quad[6], quad[7]],
            [quad[4], quad[5]],
        ];
        let mut area = 0.0f64;
        for index in 0..4 {
            let point = points[index];
            let next = points[(index + 1) % 4];
            area +=
                f64::from(point[0]) * f64::from(next[1]) - f64::from(next[0]) * f64::from(point[1]);
            rect[0] = rect[0].min(point[0]);
            rect[1] = rect[1].min(point[1]);
            rect[2] = rect[2].max(point[0]);
            rect[3] = rect[3].max(point[1]);
        }
        if !area.is_finite() || area == 0.0 {
            return Err("each highlight quad must have a finite nonzero area".to_owned());
        }
    }
    if rect.iter().any(|value| !value.is_finite())
        || rect[0] >= rect[2]
        || rect[1] >= rect[3]
        || !(rect[2] - rect[0]).is_finite()
        || !(rect[3] - rect[1]).is_finite()
    {
        return Err("highlight quads must have finite positive bounds".to_owned());
    }
    Ok(rect)
}

fn parse_paths(value: &Value) -> Result<Vec<Vec<[f32; 2]>>, String> {
    let values = array(value, "paths", MAX_INK_PATHS)?;
    let mut paths = Vec::new();
    let mut count = 0usize;
    for value in values {
        let points = array(value, "path", MAX_INK_POINTS)?;
        if points.len() < 2 {
            return Err("each ink path must contain at least two points".to_owned());
        }
        count = count.saturating_add(points.len());
        if count > MAX_INK_POINTS {
            return Err(refusal("ink_points", count, MAX_INK_POINTS));
        }
        paths.push(
            points
                .iter()
                .map(|point| fixed(point, "point"))
                .collect::<Result<_, _>>()?,
        );
    }
    Ok(paths)
}

fn annotation_arg(args: &Value) -> Result<Annot, String> {
    let kind = string_arg(args, "kind")?;
    let mut rect = fixed::<4>(
        args.get("rect")
            .ok_or_else(|| "rect is required".to_owned())?,
        "rect",
    )?;
    if rect[0] >= rect[2]
        || rect[1] >= rect[3]
        || !(rect[2] - rect[0]).is_finite()
        || !(rect[3] - rect[1]).is_finite()
    {
        return Err("rect must have finite positive width and height".to_owned());
    }
    let color = fixed::<3>(
        args.get("color")
            .ok_or_else(|| "color is required".to_owned())?,
        "color",
    )?;
    if color
        .iter()
        .any(|component| !(0.0..=1.0).contains(component))
    {
        return Err("color components must be in 0..1".to_owned());
    }
    let opacity = number(
        args.get("opacity")
            .ok_or_else(|| "opacity is required".to_owned())?,
        "opacity",
    )?;
    if !(0.0..=1.0).contains(&opacity) {
        return Err("opacity must be in 0..1".to_owned());
    }
    let contents = optional_text(args, "contents")?;
    let text = optional_text(args, "text")?;
    let width = optional_number(args, "width", 1.0)?;
    let size = optional_number(args, "size", 12.0)?;
    if width <= 0.0 || size <= 0.0 {
        return Err("width and size must be positive".to_owned());
    }
    let quads = args.get("quads").map(parse_quads).transpose()?;
    let paths = args.get("paths").map(parse_paths).transpose()?;
    let kind = match kind {
        "highlight" => {
            let quads = quads.ok_or_else(|| "quads are required for highlight".to_owned())?;
            rect = highlight_rect(&quads)?;
            // The annotation writer receives every fragment together, so its
            // QuadPoints and multiply appearance belong to one annotation.
            AnnotKind::Highlight { quads }
        }
        "note" => AnnotKind::Note,
        "ink" => AnnotKind::Ink {
            paths: paths.ok_or_else(|| "paths are required for ink".to_owned())?,
            width,
        },
        "free_text" => AnnotKind::FreeText {
            text: text.ok_or_else(|| "text is required for free_text".to_owned())?,
            size,
        },
        "square" => AnnotKind::Square { width },
        "circle" => AnnotKind::Circle { width },
        _ => return Err("unknown annotation kind".to_owned()),
    };
    Ok(Annot {
        kind,
        rect,
        color,
        opacity,
        contents,
        author: None,
    })
}

fn annotations_at(doc: &mut OpenDoc, index: usize) -> Result<Vec<Annotation>, String> {
    commands::require_unencrypted(doc)?;
    commands::ensure_page(doc, index)?;
    let page = commands::page(doc, index)?;
    let mut resolver = doc.document.resolver();
    let object = resolver.get(page.id).map_err(commands::pdf_error)?;
    Ok(page_annotations(&mut resolver, &object))
}

fn annotations_json(doc: &mut OpenDoc, index: usize) -> Result<Value, String> {
    let annotations = annotations_at(doc, index)?
        .into_iter()
        .map(|annot| {
            json!({
                "index": annot.index,
                "subtype": annot.subtype,
                "rect": annot.rect,
                "contents": annot.contents,
                "color": annot.color
            })
        })
        .collect();
    Ok(Value::Array(annotations))
}

pub(crate) fn edit_state(doc: &OpenDoc) -> Value {
    json!({
        "dirty": !doc.history.ops.is_empty(),
        "can_undo": !doc.history.ops.is_empty(),
        "can_redo": !doc.history.undone.is_empty(),
        "path": doc.history.path.to_string_lossy()
    })
}

fn rebuild<'a>(
    doc: &OpenDoc,
    ops: impl IntoIterator<Item = &'a EditOp>,
) -> Result<OpenDoc, String> {
    #[cfg(debug_assertions)]
    let started = std::time::Instant::now();

    let result = (|| {
        let mut ops = ops.into_iter().peekable();
        let bytes = if ops.peek().is_none() {
            Arc::clone(&doc.history.original)
        } else {
            let mut editor = Editor::open(Arc::clone(&doc.history.original), Limits::default())
                .map_err(|error| format!("{error:?}"))?;
            for op in ops {
                op.apply(&mut editor)?;
            }
            let bytes: Arc<[u8]> = Arc::from(editor.save().map_err(|error| format!("{error:?}"))?);
            if bytes.len() as u64 > commands::MAX_SOURCE_BYTES {
                return Err(format!(
                    "refused: source_bytes, requested={}, maximum={}",
                    bytes.len(),
                    commands::MAX_SOURCE_BYTES
                ));
            }
            if !bytes.starts_with(doc.history.original.as_ref()) {
                return Err("the editor did not preserve the original PDF prefix".to_owned());
            }
            bytes
        };
        commands::open_bytes(bytes, doc.history.path.clone())
    })();

    #[cfg(debug_assertions)]
    eprintln!("pdf-viewer: edit rebuild took {:?}", started.elapsed());

    result
}

fn install(doc: &mut OpenDoc, mut rebuilt: OpenDoc) {
    std::mem::swap(&mut doc.history, &mut rebuilt.history);
    *doc = rebuilt;
}

fn prepare_push(doc: &mut OpenDoc, op: &EditOp) -> Result<(), String> {
    let requested = doc.history.ops.len().saturating_add(1);
    if requested > MAX_HISTORY_OPS {
        return Err(refusal("history_ops", requested, MAX_HISTORY_OPS));
    }
    let bytes = doc
        .history
        .ops
        .iter()
        .fold(op.retained_bytes(), |total, existing| {
            total.saturating_add(existing.retained_bytes())
        });
    if bytes > MAX_HISTORY_BYTES {
        return Err(refusal("history_bytes", bytes, MAX_HISTORY_BYTES));
    }
    doc.history
        .ops
        .try_reserve(1)
        .map_err(|_| refusal("history_ops", requested, MAX_HISTORY_OPS))
}

fn push(doc: &mut OpenDoc, op: EditOp) -> Result<Value, String> {
    prepare_push(doc, &op)?;
    let mut rebuilt = rebuild(doc, doc.history.ops.iter().chain(std::iter::once(&op)))?;
    let reply = match &op {
        EditOp::Annotate { page, .. } => {
            let annotations = annotations_at(&mut rebuilt, *page as usize)?;
            let annotation = annotations
                .last()
                .ok_or_else(|| "the added annotation could not be read back".to_owned())?;
            json!({ "annotation": annotation.index })
        }
        _ => Value::Null,
    };
    doc.history.ops.push(op);
    doc.history.undone.clear();
    install(doc, rebuilt);
    Ok(reply)
}

fn undo(doc: &mut OpenDoc) -> Result<Value, String> {
    if doc.history.ops.is_empty() {
        return Err("nothing to undo".to_owned());
    }
    let requested = doc.history.undone.len().saturating_add(1);
    doc.history
        .undone
        .try_reserve(1)
        .map_err(|_| refusal("history_ops", requested, MAX_HISTORY_OPS))?;
    let kept = doc.history.ops.len().saturating_sub(1);
    let rebuilt = rebuild(doc, doc.history.ops.iter().take(kept))?;
    let op = doc
        .history
        .ops
        .pop()
        .ok_or_else(|| "nothing to undo".to_owned())?;
    doc.history.undone.push(op);
    install(doc, rebuilt);
    Ok(edit_state(doc))
}

fn redo(doc: &mut OpenDoc) -> Result<Value, String> {
    let op = doc
        .history
        .undone
        .last()
        .ok_or_else(|| "nothing to redo".to_owned())?;
    let rebuilt = rebuild(doc, doc.history.ops.iter().chain(std::iter::once(op)))?;
    let requested = doc.history.ops.len().saturating_add(1);
    doc.history
        .ops
        .try_reserve(1)
        .map_err(|_| refusal("history_ops", requested, MAX_HISTORY_OPS))?;
    let op = doc
        .history
        .undone
        .pop()
        .ok_or_else(|| "nothing to redo".to_owned())?;
    doc.history.ops.push(op);
    install(doc, rebuilt);
    Ok(edit_state(doc))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temporary_name = path.as_os_str().to_os_string();
    temporary_name.push(".tmp");
    let temporary = PathBuf::from(temporary_name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("could not create {}: {error}", temporary.display()))?;
    let result = (|| {
        match fs::metadata(path) {
            Ok(metadata) => file
                .set_permissions(metadata.permissions())
                .map_err(|error| format!("could not preserve file permissions: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not inspect the save path: {error}")),
        }
        file.write_all(bytes)
            .map_err(|error| format!("could not write PDF: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("could not flush PDF: {error}"))?;
        drop(file);
        fs::rename(&temporary, path)
            .map_err(|error| format!("could not replace {}: {error}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn save(doc: &mut OpenDoc, args: &Value) -> Result<Value, String> {
    let mode = string_arg(args, "mode")?;
    let path = match mode {
        "in_place" => doc.history.path.clone(),
        "copy" => {
            let stem = doc
                .history
                .path
                .file_stem()
                .ok_or_else(|| "the opened path has no file name".to_owned())?;
            let mut name = stem.to_os_string();
            name.push(".edited.pdf");
            doc.history.path.with_file_name(name)
        }
        _ => return Err("mode must be in_place or copy".to_owned()),
    };
    atomic_write(&path, &doc.bytes)?;
    if mode == "in_place" {
        doc.history.original = Arc::clone(&doc.bytes);
        doc.history.ops.clear();
        doc.history.undone.clear();
    }
    Ok(json!({ "path": path.to_string_lossy() }))
}

pub(crate) fn handles(command: &str) -> bool {
    matches!(
        command,
        "annotations"
            | "annotate"
            | "remove_annotation"
            | "rotate_page"
            | "delete_page"
            | "move_page"
            | "insert_pdf"
            | "info"
            | "set_info"
            | "undo"
            | "redo"
            | "save"
    )
}

pub(crate) fn dispatch(
    doc: &mut OpenDoc,
    command: &str,
    args: &Value,
) -> Result<(Value, bool), String> {
    commands::require_unencrypted(doc)?;
    let reply = match command {
        "annotations" => return Ok((annotations_json(doc, usize_arg(args, "index")?)?, false)),
        "info" => {
            let reader = doc
                .semantic
                .as_ref()
                .ok_or_else(|| "the semantic reader is unavailable".to_owned())?;
            let info = reader.info();
            return Ok((
                json!({
                    "title": info.title,
                    "author": info.author,
                    "subject": info.subject,
                    "keywords": info.keywords
                }),
                false,
            ));
        }
        "annotate" => {
            let page = page_arg(doc, args, "index", false)?;
            let annot = annotation_arg(args)?;
            push(doc, EditOp::Annotate { page, annot })?
        }
        "remove_annotation" => {
            let page = page_arg(doc, args, "index", false)?;
            let index = usize_arg(args, "annotation")?;
            push(doc, EditOp::RemoveAnnotation { page, index })?
        }
        "rotate_page" => {
            let page = page_arg(doc, args, "index", false)?;
            let turns = args
                .get("quarter_turns")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
                .ok_or_else(|| "quarter_turns must be a signed 32-bit integer".to_owned())?;
            push(
                doc,
                EditOp::Rotate {
                    page,
                    turns: turns.rem_euclid(4),
                },
            )?
        }
        "delete_page" => {
            let page = page_arg(doc, args, "index", false)?;
            if doc.pages.len() <= 1 {
                return Err("cannot delete the last page".to_owned());
            }
            push(doc, EditOp::Delete { page })?
        }
        "move_page" => {
            let from = page_arg(doc, args, "from", false)?;
            let to = page_arg(doc, args, "to", false)?;
            push(doc, EditOp::Move { from, to })?
        }
        "insert_pdf" => {
            let at = page_arg(doc, args, "at", true)?;
            let path = string_arg(args, "path")?;
            check_text(path, "path_bytes", MAX_PATH_BYTES)?;
            if path.is_empty() {
                return Err("path must be nonempty".to_owned());
            }
            let source = commands::read_source(Path::new(path))?;
            let imported = commands::open_bytes(Arc::clone(&source), PathBuf::from(path))?;
            commands::require_unencrypted(&imported)?;
            let count = u32::try_from(imported.pages.len())
                .map_err(|_| "the inserted PDF has too many pages".to_owned())?;
            if count == 0 {
                return Err("the inserted PDF has no pages".to_owned());
            }
            drop(imported);
            let pages = (0..count).collect();
            push(doc, EditOp::Insert { source, pages, at })?
        }
        "set_info" => {
            let key = match string_arg(args, "key")? {
                "title" | "Title" => "Title",
                "author" | "Author" => "Author",
                "subject" | "Subject" => "Subject",
                "keywords" | "Keywords" => "Keywords",
                _ => return Err("key must be title, author, subject or keywords".to_owned()),
            };
            let text = string_arg(args, "text")?;
            check_text(text, "info_text_bytes", MAX_TEXT_BYTES)?;
            push(
                doc,
                EditOp::SetInfo {
                    key,
                    text: text.to_owned(),
                },
            )?
        }
        "undo" => undo(doc)?,
        "redo" => redo(doc)?,
        "save" => save(doc, args)?,
        _ => return Err(format!("unknown editing command: {command}")),
    };
    Ok((reply, true))
}

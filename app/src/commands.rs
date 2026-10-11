use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::editing::{self, History};
use pdf_toolkit::core::pages::{Page, PageWalk};
use pdf_toolkit::core::{Document, Limits, ObjectRef, OpenMode, PdfSource, XrefEntry};
use pdf_toolkit::raster::{encode_png, Raster};
use pdf_toolkit::render::RenderOptions;
use pdf_toolkit::text::extract::page_receipt_cached;
use pdf_toolkit::text::font::FontCache;
use pdf_toolkit::text::images::{load_image, ImageData};
use pdf_toolkit::text::semantic::{LinkTarget, SemanticKind, SemanticPage, SemanticReader};
use serde_json::{json, Value};

pub(crate) const MAX_SOURCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PIXELS: u64 = 16_000_000;
const MAX_SEARCH_HITS: u64 = 10_000;
const MAX_QUERY_BYTES: usize = 4096;
const MAX_SEARCH_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_PASSWORD_BYTES: usize = 1024 * 1024;
const MAX_ENCRYPTED_OBJECTS: u32 = 1_000_000;
const THUMBNAIL_WIDTH: f64 = 160.0;

pub type State = Arc<Mutex<Option<OpenDoc>>>;

pub struct OpenDoc {
    pub(crate) bytes: Arc<[u8]>,
    pub(crate) document: Document,
    pub(crate) pages: Vec<Page>,
    font_cache: FontCache,
    pub(crate) semantic: Option<SemanticReader>,
    semantic_next: usize,
    summary: Value,
    pub(crate) history: History,
}

fn refusal(kind: &str, requested: u64, maximum: u64) -> String {
    format!("refused: {kind}, requested={requested}, maximum={maximum}")
}

pub(crate) fn pdf_error(error: pdf_toolkit::core::DocError) -> String {
    format!("{error:?}")
}

fn open_error(error: pdf_toolkit::core::DocError, password_supplied: bool) -> String {
    let wrong_password = password_supplied
        && match &error {
            pdf_toolkit::core::DocError::Encrypted => true,
            pdf_toolkit::core::DocError::Malformed { what, .. } => {
                what.contains("password") || what.contains("authentication")
            }
            _ => false,
        };
    if wrong_password {
        "Incorrect password".to_owned()
    } else {
        pdf_error(error)
    }
}

/// A source over the shared bytes; fails only when there is no PDF header.
pub(crate) fn source(bytes: &Arc<[u8]>) -> Result<PdfSource, String> {
    PdfSource::new(Arc::clone(bytes)).map_err(|error| error.to_string())
}

pub(crate) fn read_source(path: &Path) -> Result<Arc<[u8]>, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("could not open {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("could not inspect {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err("the PDF path must name a regular file".to_owned());
    }
    let length = metadata.len();
    if length > MAX_SOURCE_BYTES {
        return Err(refusal("source_bytes", length, MAX_SOURCE_BYTES));
    }
    let length = usize::try_from(length)
        .map_err(|_| refusal("source_bytes", length, MAX_SOURCE_BYTES))?;
    let mut storage = Vec::new();
    storage
        .try_reserve_exact(length)
        .map_err(|_| refusal("source_bytes", length as u64, MAX_SOURCE_BYTES))?;
    storage.resize(length, 0);

    let mut bytes: Arc<[u8]> = Arc::from(storage);
    let destination = Arc::get_mut(&mut bytes)
        .ok_or_else(|| "could not obtain the new PDF buffer".to_owned())?;
    file.read_exact(destination)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let mut extra = [0u8; 1];
    if file
        .read(&mut extra)
        .map_err(|error| format!("could not finish reading {}: {error}", path.display()))?
        != 0
    {
        return Err("the PDF changed while it was being opened; open it again".to_owned());
    }
    Ok(bytes)
}

pub fn open_path(state: &State, path: &Path) -> Result<Value, String> {
    open_path_with_password(state, path, None)
}

fn open_path_with_password(
    state: &State,
    path: &Path,
    password: Option<&[u8]>,
) -> Result<Value, String> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("could not locate the current directory: {error}"))?
            .join(path)
    };
    let bytes = read_source(&path)?;
    let opened = open_bytes_with_password(bytes, path, password)?;
    let summary = opened.summary.clone();

    let mut current = state
        .lock()
        .map_err(|_| "the document state is unavailable".to_owned())?;
    *current = Some(opened);
    Ok(summary)
}

pub(crate) fn open_bytes(bytes: Arc<[u8]>, path: PathBuf) -> Result<OpenDoc, String> {
    open_bytes_with_password(bytes, path, None)
}

fn open_bytes_with_password(
    bytes: Arc<[u8]>,
    path: PathBuf,
    password: Option<&[u8]>,
) -> Result<OpenDoc, String> {
    let limits = Limits::default();
    // Repair mode tries the strict open first; damaged files (broken xref, object streams or
    // page tree) fall back to the recovering reader instead of being refused.
    let document = Document::open_with_password_mode(
        source(&bytes)?,
        limits,
        OpenMode::Repair,
        password,
    )
    .map_err(|error| open_error(error, password.is_some()))?;
    let encrypted = document.encrypted();

    let pages = {
        let mut resolver = document.resolver();
        let mut pages = Vec::new();
        match PageWalk::new(&mut resolver) {
            Ok(walk) => {
                for page in walk {
                    match page {
                        Ok(page) => pages.push(page),
                        Err(pdf_toolkit::core::DocError::Encrypted) if encrypted => break,
                        Err(error) => return Err(pdf_error(error)),
                    }
                }
            }
            Err(pdf_toolkit::core::DocError::Encrypted) if encrypted => {}
            Err(error) => return Err(pdf_error(error)),
        }
        pages
    };

    let mut semantic = if encrypted {
        None
    } else {
        Some(
            SemanticReader::open_with(source(&bytes)?, limits, OpenMode::Repair)
                .map_err(pdf_error)?,
        )
    };
    let title = semantic
        .as_ref()
        .and_then(|reader| reader.info().title.clone());
    let outline: Vec<Value> = semantic
        .as_mut()
        .map(|reader| {
            reader
                .outline()
                .into_iter()
                .map(|item| {
                    let page = match item.target {
                        Some(LinkTarget::Page { index, .. }) => Some(index),
                        _ => None,
                    };
                    json!({
                        "title": item.title,
                        "level": item.level,
                        "page": page
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let summary = json!({
        "title": title,
        "pages": pages.len(),
        "encrypted": encrypted,
        "outline": outline
    });
    Ok(OpenDoc {
        history: History::new(Arc::clone(&bytes), path),
        bytes,
        document,
        pages,
        font_cache: FontCache::default(),
        semantic,
        semantic_next: 0,
        summary,
    })
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
}

fn index_arg(args: &Value) -> Result<usize, String> {
    let index = args
        .get("index")
        .and_then(Value::as_u64)
        .ok_or_else(|| "index must be a nonnegative integer".to_owned())?;
    usize::try_from(index).map_err(|_| "index is out of range".to_owned())
}

pub(crate) fn page(doc: &OpenDoc, index: usize) -> Result<&Page, String> {
    doc.pages
        .get(index)
        .ok_or_else(|| format!("page index {index} is out of range"))
}

fn dimensions(page: &Page) -> Result<(f64, f64), String> {
    let [x0, y0, x1, y1] = page.crop_box;
    let width = (x1 - x0).max(0.0) * page.user_unit;
    let height = (y1 - y0).max(0.0) * page.user_unit;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("the page has invalid display dimensions".to_owned());
    }
    if matches!(page.rotate.rem_euclid(360), 90 | 270) {
        Ok((height, width))
    } else {
        Ok((width, height))
    }
}

pub(crate) fn require_unencrypted(doc: &OpenDoc) -> Result<(), String> {
    if doc.document.encrypted() {
        Err("encrypted documents cannot be decoded".to_owned())
    } else {
        Ok(())
    }
}

fn require_decryptable(doc: &OpenDoc) -> Result<(), String> {
    if doc.document.decryptable() {
        Ok(())
    } else {
        Err("encrypted documents cannot be decoded".to_owned())
    }
}

fn capped_scale(width: f64, height: f64, requested: f64) -> Result<f32, String> {
    if !requested.is_finite() || requested <= 0.0 {
        return Err("scale must be finite and positive".to_owned());
    }
    let width = width as f32;
    let height = height as f32;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("the page dimensions cannot be rasterized".to_owned());
    }
    let area = f64::from(width) * f64::from(height);
    let maximum = MAX_PIXELS as f64;
    let bound = (maximum / area)
        .sqrt()
        .min(maximum / f64::from(width))
        .min(maximum / f64::from(height));
    let mut scale = requested.min(bound).min(f64::from(f32::MAX)) as f32;

    for _ in 0..128 {
        if !scale.is_finite() || scale <= 0.0 {
            return Err("scale is too small to rasterize this page".to_owned());
        }
        let pixels_wide = (width * scale).ceil().max(1.0) as u64;
        let pixels_high = (height * scale).ceil().max(1.0) as u64;
        if pixels_wide
            .checked_mul(pixels_high)
            .is_some_and(|pixels| pixels <= MAX_PIXELS)
        {
            return Ok(scale);
        }
        scale *= 0.99;
    }
    Err(refusal("raster_pixels", u64::MAX, MAX_PIXELS))
}

fn png_bytes(raster: &Raster) -> Result<Vec<u8>, String> {
    let pixels = u64::from(raster.width)
        .checked_mul(u64::from(raster.height))
        .ok_or_else(|| refusal("raster_pixels", u64::MAX, MAX_PIXELS))?;
    if pixels == 0 || pixels > MAX_PIXELS {
        return Err(refusal("raster_pixels", pixels, MAX_PIXELS));
    }
    let expected = pixels
        .checked_mul(4)
        .and_then(|length| usize::try_from(length).ok())
        .ok_or_else(|| refusal("raster_bytes", u64::MAX, MAX_PIXELS * 4))?;
    if raster.rgba.len() != expected {
        return Err("the raster buffer has an invalid length".to_owned());
    }
    let bytes = encode_png(raster);
    if bytes.is_empty() {
        return Err("PNG encoding failed".to_owned());
    }
    Ok(bytes)
}

/// Inter Regular (OFL, assets/Inter-LICENSE) decoded from WOFF at build time.
fn fallback_font() -> Arc<[u8]> {
    static FONT: std::sync::OnceLock<Arc<[u8]>> = std::sync::OnceLock::new();
    FONT.get_or_init(|| Arc::from(&include_bytes!(concat!(env!("OUT_DIR"), "/fallback.ttf"))[..]))
        .clone()
}

fn render(doc: &OpenDoc, index: usize, requested: f64) -> Result<Value, String> {
    require_decryptable(doc)?;
    let page = page(doc, index)?;
    let (width, height) = dimensions(page)?;
    let scale = capped_scale(width, height, requested)?;
    let options = RenderOptions { scale: scale as f32, fallback_font: Some(fallback_font()) };
    let mut resolver = doc.document.resolver();
    let raster = pdf_toolkit::raster::render_page(
        &mut resolver,
        page,
        &options,
        [255, 255, 255, 255],
    )
    .map_err(pdf_error)?;
    let png = png_bytes(&raster)?;
    Ok(json!({
        "width": raster.width,
        "height": raster.height,
        "png": base64(&png)
    }))
}

fn object_arg(args: &Value) -> Result<ObjectRef, String> {
    let mut parts = string_arg(args, "object")?.split_whitespace();
    let number = parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .filter(|number| *number != 0)
        .ok_or_else(|| "object must contain a positive object number".to_owned())?;
    let generation = parts
        .next()
        .and_then(|part| part.parse::<u16>().ok())
        .ok_or_else(|| "object must contain a generation in 0..65535".to_owned())?;
    if parts.next().is_some() {
        return Err("object must have the form \"N G\"".to_owned());
    }
    Ok(ObjectRef::new(number, generation))
}

fn image(doc: &OpenDoc, args: &Value) -> Result<Value, String> {
    require_decryptable(doc)?;
    let mut resolver = doc.document.resolver();
    let image = load_image(&mut resolver, object_arg(args)?, MAX_PIXELS)
        .map_err(pdf_error)?;
    let (mime, data) = match image.data {
        ImageData::Jpeg(data) => ("image/jpeg", data),
        ImageData::Pixels { rgba } => {
            let raster = Raster {
                width: image.width,
                height: image.height,
                rgba,
            };
            ("image/png", png_bytes(&raster)?)
        }
        ImageData::Unsupported(reason) => {
            return Err(format!("unsupported page image: {reason}"));
        }
    };
    Ok(json!({ "mime": mime, "data": base64(&data) }))
}

fn semantic_at(doc: &mut OpenDoc, index: usize) -> Result<SemanticPage, String> {
    require_unencrypted(doc)?;
    page(doc, index)?;

    if doc.semantic.is_none() || index < doc.semantic_next {
        doc.semantic = Some(
            SemanticReader::open_with(
                source(&doc.bytes)?,
                *doc.document.limits(),
                OpenMode::Repair,
            )
            .map_err(pdf_error)?,
        );
        doc.semantic_next = 0;
    }

    while doc.semantic_next <= index {
        let reader = doc
            .semantic
            .as_mut()
            .ok_or_else(|| "the semantic reader is unavailable".to_owned())?;
        let result = reader
            .next_page()
            .ok_or_else(|| "the semantic reader ended before the requested page".to_owned())?;
        let position = doc.semantic_next;
        doc.semantic_next = doc.semantic_next.saturating_add(1);
        if position == index {
            return Ok(result);
        }
    }
    Err("the semantic reader could not locate the requested page".to_owned())
}

fn target_json(target: &LinkTarget) -> Value {
    match target {
        LinkTarget::Uri(uri) => json!({ "uri": uri }),
        LinkTarget::Page { index, y } => json!({ "page": index, "y": y }),
    }
}

fn semantic_json(page: &SemanticPage) -> Value {
    let blocks: Vec<Value> = page
        .blocks
        .iter()
        .map(|block| {
            let kind = match block.kind {
                SemanticKind::Paragraph => "paragraph".to_owned(),
                SemanticKind::Heading(level) => format!("h{level}"),
                SemanticKind::ListItem => "list_item".to_owned(),
                SemanticKind::Caption => "caption".to_owned(),
            };
            let spans: Vec<Value> = block
                .spans
                .iter()
                .map(|span| {
                    json!({
                        "text": span.text,
                        "bold": span.style.bold,
                        "italic": span.style.italic,
                        "monospace": span.style.monospace,
                        "size": span.size,
                        "link": span.link
                    })
                })
                .collect();
            json!({
                "kind": kind,
                "bbox": block.bbox,
                "spans": spans
            })
        })
        .collect();
    let images: Vec<Value> = page
        .images
        .iter()
        .map(|image| {
            let object = image
                .object
                .map(|id| format!("{} {}", id.number(), id.generation()));
            json!({
                "bbox": image.bbox,
                "object": object,
                "width": image.width,
                "height": image.height,
                "inline": image.inline
            })
        })
        .collect();
    let links: Vec<Value> = page
        .links
        .iter()
        .map(|link| {
            json!({
                "bbox": link.bbox,
                "target": target_json(&link.target)
            })
        })
        .collect();
    json!({
        "index": page.index,
        "width": page.width,
        "height": page.height,
        "blocks": blocks,
        "images": images,
        "links": links,
        "refusal": page.refusal
    })
}

fn snippet(text: &str, folded_offset: usize) -> String {
    let mut folded_bytes = 0usize;
    let mut position = 0usize;
    for character in text.chars() {
        let length: usize = character.to_lowercase().map(char::len_utf8).sum();
        if folded_bytes.saturating_add(length) > folded_offset {
            break;
        }
        folded_bytes = folded_bytes.saturating_add(length);
        position = position.saturating_add(1);
    }
    let start = position.saturating_sub(48);
    let mut characters = text.chars().skip(start);
    let mut result = String::new();
    if start != 0 {
        result.push('…');
    }
    for character in characters.by_ref().take(192) {
        result.push(character);
    }
    if characters.next().is_some() {
        result.push('…');
    }
    result
}

fn search(doc: &mut OpenDoc, args: &Value) -> Result<Value, String> {
    require_unencrypted(doc)?;
    let query = string_arg(args, "query")?;
    if query.len() > MAX_QUERY_BYTES {
        return Err(refusal(
            "query_bytes",
            query.len() as u64,
            MAX_QUERY_BYTES as u64,
        ));
    }
    let maximum = args
        .get("max")
        .and_then(Value::as_u64)
        .ok_or_else(|| "max must be a nonnegative integer".to_owned())?;
    if maximum > MAX_SEARCH_HITS {
        return Err(refusal("search_hits", maximum, MAX_SEARCH_HITS));
    }
    if query.is_empty() || maximum == 0 {
        return Ok(json!([]));
    }
    let needle = query.to_lowercase();
    let mut hits = Vec::new();

    for index in 0..doc.pages.len() {
        // Borrow the fields separately: the page and the resolver are shared,
        // the font cache is the one mutable piece.
        let descriptor = doc
            .pages
            .get(index)
            .ok_or_else(|| format!("page index {index} is out of range"))?;
        let mut resolver = doc.document.resolver();
        let receipt = page_receipt_cached(&mut resolver, descriptor, &mut doc.font_cache);
        if let Some(error) = receipt.refusal {
            match error {
                error @ (pdf_toolkit::core::DocError::Refused(_)
                | pdf_toolkit::core::DocError::Encrypted) => {
                    return Err(pdf_error(error));
                }
                error => {
                    eprintln!("pdf-viewer: skipping search page {index}: {error:?}");
                    continue;
                }
            }
        }
        drop(resolver);

        let semantic = semantic_at(doc, index)?;
        if let Some(reason) = semantic.refusal {
            return Err(format!("semantic page {index} refused: {reason}"));
        }
        for block in semantic.blocks {
            let mut text = String::new();
            for span in block.spans {
                let requested = text.len().saturating_add(span.text.len());
                if requested > MAX_SEARCH_TEXT_BYTES {
                    return Err(refusal(
                        "search_text_bytes",
                        requested as u64,
                        MAX_SEARCH_TEXT_BYTES as u64,
                    ));
                }
                text.push_str(&span.text);
            }
            let folded = text.to_lowercase();
            for (offset, _) in folded.match_indices(needle.as_str()) {
                hits.push(json!({
                    "page": index,
                    "snippet": snippet(&text, offset),
                    "bbox": block.bbox
                }));
                if hits.len() as u64 >= maximum {
                    return Ok(Value::Array(hits));
                }
            }
        }
    }
    Ok(Value::Array(hits))
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk.first().copied().unwrap_or(0);
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        let indices = [
            a >> 2,
            ((a & 3) << 4) | (b >> 4),
            ((b & 15) << 2) | (c >> 6),
            c & 63,
        ];
        for (position, index) in indices.into_iter().enumerate() {
            if (position == 2 && chunk.len() < 2)
                || (position == 3 && chunk.len() < 3)
            {
                output.push('=');
            } else if let Some(character) = ALPHABET.get(usize::from(index)) {
                output.push(char::from(*character));
            }
        }
    }
    output
}

fn writer_name(bytes: Vec<u8>) -> Result<String, String> {
    String::from_utf8(bytes)
        .map_err(|_| "PDF names must be UTF-8 to save an encrypted copy".to_owned())
}

fn writer_value(
    value: pdf_toolkit::core::ValueRef<'_>,
    references: &BTreeMap<u32, u32>,
) -> Result<pdf_toolkit::write::Value, String> {
    use pdf_toolkit::core::ValueKind;
    use pdf_toolkit::write::Value as WriteValue;

    match value.kind() {
        ValueKind::Null => Ok(WriteValue::Null),
        ValueKind::Bool => Ok(WriteValue::Bool(
            value
                .as_bool()
                .ok_or_else(|| "PDF boolean value is invalid".to_owned())?,
        )),
        ValueKind::Int => Ok(WriteValue::Int(
            value
                .as_i64()
                .ok_or_else(|| "PDF integer value is invalid".to_owned())?,
        )),
        ValueKind::Real => {
            let number = value
                .as_f64()
                .ok_or_else(|| "PDF real value is invalid".to_owned())?;
            if !number.is_finite() {
                return Err("PDF real value is not finite".to_owned());
            }
            Ok(WriteValue::Real(number))
        }
        ValueKind::Name => {
            let name = value
                .as_name()
                .ok_or_else(|| "PDF name value is invalid".to_owned())?;
            Ok(WriteValue::Name(writer_name(name.decoded().into_owned())?))
        }
        ValueKind::String => {
            let string = value
                .as_str()
                .ok_or_else(|| "PDF string value is invalid".to_owned())?;
            Ok(WriteValue::Str(string.decode()))
        }
        ValueKind::Array => {
            let array = value
                .as_array()
                .ok_or_else(|| "PDF array value is invalid".to_owned())?;
            let mut values = Vec::new();
            for item in array.iter() {
                values.push(writer_value(item, references)?);
            }
            Ok(WriteValue::Array(values))
        }
        ValueKind::Dict => {
            let dictionary = value
                .as_dict()
                .ok_or_else(|| "PDF dictionary value is invalid".to_owned())?;
            let mut values = Vec::new();
            for (key, item) in dictionary.iter() {
                values.push((
                    writer_name(key.decoded().into_owned())?,
                    writer_value(item, references)?,
                ));
            }
            Ok(WriteValue::Dict(values))
        }
        ValueKind::Ref => {
            let id = value
                .as_ref()
                .ok_or_else(|| "PDF reference value is invalid".to_owned())?;
            let number = references
                .get(&id.number())
                .copied()
                .ok_or_else(|| format!("PDF reference {} is missing", id.number()))?;
            Ok(WriteValue::Ref(number, 0))
        }
    }
}

fn encrypted_pdf(doc: &OpenDoc, password: &[u8]) -> Result<Vec<u8>, String> {
    let object_count = doc.document.xref().size().saturating_sub(1);
    if object_count > MAX_ENCRYPTED_OBJECTS {
        return Err(refusal(
            "encrypted_objects",
            u64::from(object_count),
            u64::from(MAX_ENCRYPTED_OBJECTS),
        ));
    }

    let mut writer = pdf_toolkit::write::Writer::new_encrypted("2.0", password, None)
        .map_err(|error| error.to_string())?;
    let mut references = BTreeMap::new();
    let mut objects = Vec::new();
    let capacity = usize::try_from(object_count)
        .map_err(|_| refusal("encrypted_objects", u64::from(object_count), u64::from(MAX_ENCRYPTED_OBJECTS)))?;
    objects
        .try_reserve_exact(capacity)
        .map_err(|_| refusal("encrypted_objects", u64::from(object_count), u64::from(MAX_ENCRYPTED_OBJECTS)))?;

    for number in 1..doc.document.xref().size() {
        let source_id = match doc.document.xref().get(number) {
            Some(XrefEntry::InUse { generation, .. }) => ObjectRef::new(number, generation),
            Some(XrefEntry::Compressed { .. }) => ObjectRef::new(number, 0),
            Some(XrefEntry::Free) | None => continue,
        };
        let destination = writer.alloc().map_err(|error| error.to_string())?;
        references.insert(number, destination);
        objects.push((source_id, destination));
    }

    let root = doc
        .document
        .root_ref()
        .ok_or_else(|| "the PDF has no catalog".to_owned())?;
    let root = references
        .get(&root.number())
        .copied()
        .ok_or_else(|| "the PDF catalog is missing".to_owned())?;

    let mut resolver = doc.document.resolver();
    for (source_id, destination) in objects {
        let object = resolver.get(source_id).map_err(pdf_error)?;
        let value = writer_value(object.root(), &references)?;
        match (object.is_stream(), value) {
            (true, pdf_toolkit::write::Value::Dict(dictionary)) => {
                let data = object
                    .stream_raw()
                    .ok_or_else(|| "PDF stream data is unavailable".to_owned())?;
                writer
                    .stream(destination, dictionary, data)
                    .map_err(|error| error.to_string())?;
            }
            (true, _) => return Err("PDF stream dictionary is invalid".to_owned()),
            (false, value) => {
                writer
                    .object(destination, &value)
                    .map_err(|error| error.to_string())?;
            }
        }
        let written = writer.bytes().len() as u64;
        if written > MAX_SOURCE_BYTES {
            return Err(refusal("source_bytes", written, MAX_SOURCE_BYTES));
        }
    }

    let mut extra = Vec::new();
    if let Some(trailer) = doc.document.trailer().dict() {
        for (key, value) in trailer.iter() {
            let key = writer_name(key.decoded().into_owned())?;
            if matches!(
                key.as_str(),
                "Root" | "Size" | "Encrypt" | "ID" | "Prev" | "XRefStm"
            ) {
                continue;
            }
            extra.push((key, writer_value(value, &references)?));
        }
    }
    writer
        .finish_table(root, extra)
        .map_err(|error| error.to_string())?;
    let bytes = writer.into_bytes();
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(refusal(
            "source_bytes",
            bytes.len() as u64,
            MAX_SOURCE_BYTES,
        ));
    }
    Ok(bytes)
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

fn save_encrypted_copy(doc: &OpenDoc, args: &Value) -> Result<Value, String> {
    require_unencrypted(doc)?;
    let path_text = string_arg(args, "path")?;
    if path_text.is_empty() {
        return Err("path must be nonempty".to_owned());
    }
    if path_text.len() > MAX_PATH_BYTES {
        return Err(refusal(
            "path_bytes",
            path_text.len() as u64,
            MAX_PATH_BYTES as u64,
        ));
    }
    let password = string_arg(args, "password")?;
    if password.is_empty() {
        return Err("password must be nonempty".to_owned());
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(refusal(
            "password_bytes",
            password.len() as u64,
            MAX_PASSWORD_BYTES as u64,
        ));
    }

    let path = Path::new(path_text);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("could not locate the current directory: {error}"))?
            .join(path)
    };
    let state = editing::edit_state(doc);
    if state
        .get("path")
        .and_then(Value::as_str)
        .is_some_and(|source| Path::new(source) == path.as_path())
    {
        return Err("choose a new path for the encrypted copy".to_owned());
    }

    let bytes = encrypted_pdf(doc, password.as_bytes())?;
    atomic_write(&path, &bytes)?;
    Ok(json!({ "path": path.to_string_lossy() }))
}

fn dispatch(
    state: &State,
    handle: &izumo::AppHandle,
    command: &str,
    args: Value,
) -> Result<Value, String> {
    if !args.is_object() {
        return Err("command arguments must be an object".to_owned());
    }
    if command == "open_file" {
        let path = string_arg(&args, "path")?;
        if path.is_empty() {
            return Err("path must be nonempty".to_owned());
        }
        let reply = open_path(state, Path::new(path))?;
        if let Err(error) = handle.emit("document_opened", &reply) {
            eprintln!("pdf-viewer: could not announce the opened document: {error}");
        }
        return Ok(reply);
    }
    if command == "open_file_with_password" {
        let path = string_arg(&args, "path")?;
        if path.is_empty() {
            return Err("path must be nonempty".to_owned());
        }
        let password = string_arg(&args, "password")?;
        if password.len() > MAX_PASSWORD_BYTES {
            return Err(refusal(
                "password_bytes",
                password.len() as u64,
                MAX_PASSWORD_BYTES as u64,
            ));
        }
        let reply = open_path_with_password(
            state,
            Path::new(path),
            Some(password.as_bytes()),
        )?;
        if let Err(error) = handle.emit("document_opened", &reply) {
            eprintln!("pdf-viewer: could not announce the opened document: {error}");
        }
        return Ok(reply);
    }

    let mut current = state
        .lock()
        .map_err(|_| "the document state is unavailable".to_owned())?;
    if command == "__viewer_current_document" {
        return Ok(current
            .as_ref()
            .map(|doc| doc.summary.clone())
            .unwrap_or(Value::Null));
    }
    if command == "pick_and_open" {
        return current
            .as_ref()
            .map(|doc| doc.summary.clone())
            .ok_or_else(|| {
                "Pass a PDF path to pdf-viewer or drop a local PDF onto the window.".to_owned()
            });
    }
    if command == "edit_state" {
        return Ok(current
            .as_ref()
            .map(editing::edit_state)
            .unwrap_or_else(|| json!({
                "dirty": false,
                "can_undo": false,
                "can_redo": false,
                "path": null
            })));
    }
    let doc = current
        .as_mut()
        .ok_or_else(|| "open a PDF first".to_owned())?;

    if command == "save_encrypted_copy" {
        return save_encrypted_copy(doc, &args);
    }

    if editing::handles(command) {
        let (reply, changed) = editing::dispatch(doc, command, &args)?;
        let pages = doc.pages.len();
        drop(current);
        if changed {
            crate::document_changed(handle, pages);
        }
        return Ok(reply);
    }

    match command {
        "page_size" => {
            let descriptor = page(doc, index_arg(&args)?)?;
            let (width, height) = dimensions(descriptor)?;
            let rotate = descriptor.rotate.rem_euclid(360);
            if !matches!(rotate, 0 | 90 | 180 | 270) {
                return Err("the page has an invalid rotation".to_owned());
            }
            let [x0, y0, _, _] = descriptor.crop_box;
            if !x0.is_finite() || !y0.is_finite() {
                return Err("the page has an invalid crop box origin".to_owned());
            }
            let user_unit = descriptor.user_unit;
            if !user_unit.is_finite() || user_unit <= 0.0 {
                return Err("the page has an invalid user unit".to_owned());
            }
            Ok(json!({
                "width": width,
                "height": height,
                "rotate": rotate,
                "origin": [x0, y0],
                "user_unit": user_unit
            }))
        }
        "render_page" => {
            let scale = args
                .get("scale")
                .and_then(Value::as_f64)
                .ok_or_else(|| "scale must be a number".to_owned())?;
            render(doc, index_arg(&args)?, scale)
        }
        "thumbnail" => {
            let index = index_arg(&args)?;
            let (width, _) = dimensions(page(doc, index)?)?;
            render(doc, index, THUMBNAIL_WIDTH / width)
        }
        "semantic_page" => {
            let result = semantic_at(doc, index_arg(&args)?)?;
            Ok(semantic_json(&result))
        }
        "page_image" => image(doc, &args),
        "search" => search(doc, &args),
        _ => Err(format!("unknown PDF Viewer command: {command}")),
    }
}

pub fn table(state: State, handle: izumo::AppHandle) -> Vec<(&'static str, izumo::CommandHandler)> {
    [
        "open_file",
        "open_file_with_password",
        "pick_and_open",
        "page_size",
        "render_page",
        "semantic_page",
        "page_image",
        "search",
        "thumbnail",
        "edit_state",
        "annotations",
        "annotate",
        "remove_annotation",
        "rotate_page",
        "delete_page",
        "move_page",
        "insert_pdf",
        "info",
        "set_info",
        "undo",
        "redo",
        "save",
        "save_encrypted_copy",
        "__viewer_current_document",
    ]
    .into_iter()
    .map(|command| {
        let state = Arc::clone(&state);
        let handle = handle.clone();
        let handler: izumo::CommandHandler =
            Arc::new(move |args| dispatch(&state, &handle, command, args));
        (command, handler)
    })
    .collect()
}

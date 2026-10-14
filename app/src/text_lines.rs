use std::sync::Arc;

use pdf_toolkit::text::{layout, page_text};
use serde_json::{Value, json};

use crate::commands::{self, OpenDoc, State};

const MAX_LINES: usize = 4096;
const MAX_GLYPHS: usize = 65_536;

pub(crate) fn extract(doc: &mut OpenDoc, index: usize) -> Result<Value, String> {
    commands::require_unencrypted(doc)?;
    commands::ensure_page(doc, index)?;
    let page = doc
        .pages
        .get(index)
        .and_then(Option::as_ref)
        .ok_or_else(|| format!("page index {index} is out of range"))?;
    let mut resolver = doc.document.resolver();
    let text = page_text(&mut resolver, page).map_err(|error| format!("{error:?}"))?;
    if text.glyphs.len() > MAX_GLYPHS {
        return Err(format!(
            "refused: text_glyphs, requested={}, maximum={MAX_GLYPHS}",
            text.glyphs.len()
        ));
    }

    // Lines are in reading order. Each line's glyph range indexes page_layout.order, which
    // holds indexes into text.glyphs.
    let page_layout = layout(&text);
    let mut lines = Vec::new();
    for line in &page_layout.lines {
        let bbox = line.bbox;
        if bbox.iter().any(|value| !value.is_finite()) {
            return Err("the text layer has a nonfinite line box".to_owned());
        }
        if bbox[0] >= bbox[2] || bbox[1] >= bbox[3] {
            continue;
        }
        let ids = page_layout
            .order
            .get(line.glyphs.start as usize..line.glyphs.end as usize)
            .ok_or_else(|| "the text layer has an invalid glyph range".to_owned())?;
        let mut boxes = Vec::with_capacity(ids.len());
        let mut characters = Vec::with_capacity(ids.len());
        for &id in ids {
            let glyph = text
                .glyphs
                .get(id as usize)
                .ok_or_else(|| "the text layer has an invalid glyph index".to_owned())?;
            let end = glyph.x + glyph.width;
            if !glyph.x.is_finite() || !end.is_finite() {
                return Err("the text layer has a nonfinite glyph box".to_owned());
            }
            let x0 = glyph.x.min(end);
            let x1 = glyph.x.max(end);
            if x0 < x1 {
                boxes.push([x0, x1]);
                // One string per kept box. An unmapped font has no Unicode characters.
                characters.push(if glyph.mapped {
                    glyph.text.as_slice().iter().copied().collect::<String>()
                } else {
                    "\u{FFFD}".to_owned()
                });
            }
        }
        if boxes.is_empty() {
            continue;
        }
        if lines.len() == MAX_LINES {
            return Err(format!(
                "refused: text_lines, requested={}, maximum={MAX_LINES}",
                lines.len() + 1
            ));
        }
        // Preserve the layout's reading order and each line's glyph order.
        lines.push(json!({ "bbox": bbox, "glyphs": boxes, "text": characters }));
    }
    Ok(Value::Array(lines))
}

pub(crate) fn handler(state: State) -> izumo::CommandHandler {
    Arc::new(move |args: Value| {
        if !args.is_object() {
            return Err("command arguments must be an object".to_owned());
        }
        let index = args
            .get("page_index")
            .and_then(Value::as_u64)
            .ok_or_else(|| "page_index must be a nonnegative integer".to_owned())?;
        let index = usize::try_from(index).map_err(|_| "page_index is out of range".to_owned())?;
        let mut current = state
            .lock()
            .map_err(|_| "the document state is unavailable".to_owned())?;
        let doc = current
            .as_mut()
            .ok_or_else(|| "open a PDF first".to_owned())?;
        extract(doc, index)
    })
}

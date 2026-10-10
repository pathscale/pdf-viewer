import type { Bbox, PageSize, Point, Quad, TextLine } from "./api";
import { bounds, displayToPdf } from "./pageCoordinates";

// Text lines arrive in display space (origin top-left, y down, page_size units), so hit tests use
// display points and each fragment is converted to PDF space only at the end.

export interface GlyphPosition {
  line: number;
  glyph: number;
}

function distance(value: number, low: number, high: number): number {
  return Math.max(low - value, value - high, 0);
}

// Starting a drag requires a glyph hit. Blank margins retain rectangle drawing.
export function glyphAt(lines: TextLine[], point: Point): GlyphPosition | null {
  for (let line = 0; line < lines.length; line++) {
    const item = lines[line];
    if (point[1] < item.bbox[1] || point[1] > item.bbox[3]) continue;
    for (let glyph = 0; glyph < item.glyphs.length; glyph++) {
      const [x0, x1] = item.glyphs[glyph];
      if (point[0] >= x0 && point[0] <= x1) return { line, glyph };
    }
  }
  return null;
}

// During a text drag, gaps and margins snap to the nearest line and glyph.
// Vertical distance takes precedence so dragging through a line gap advances
// the selection without reverting to a free rectangle.
export function nearestGlyph(lines: TextLine[], point: Point): GlyphPosition | null {
  const hit = glyphAt(lines, point);
  if (hit) return hit;
  let result: GlyphPosition | null = null;
  let bestY = Number.POSITIVE_INFINITY;
  let bestX = Number.POSITIVE_INFINITY;
  for (let line = 0; line < lines.length; line++) {
    const item = lines[line];
    const dy = distance(point[1], item.bbox[1], item.bbox[3]);
    for (let glyph = 0; glyph < item.glyphs.length; glyph++) {
      const [x0, x1] = item.glyphs[glyph];
      const dx = distance(point[0], x0, x1);
      if (dy < bestY || (dy === bestY && dx < bestX)) {
        result = { line, glyph };
        bestY = dy;
        bestX = dx;
      }
    }
  }
  return result;
}

export function textFragments(
  lines: TextLine[],
  anchor: GlyphPosition,
  endpoint: GlyphPosition,
  size: PageSize,
): { rect: Bbox; quads: Quad[] } {
  const backward =
    anchor.line > endpoint.line ||
    (anchor.line === endpoint.line && anchor.glyph > endpoint.glyph);
  const first = backward ? endpoint : anchor;
  const last = backward ? anchor : endpoint;
  const quads: Quad[] = [];
  const corners: Point[] = [];
  for (let index = first.line; index <= last.line; index++) {
    const line = lines[index];
    const start = index === first.line ? first.glyph : 0;
    const end = index === last.line ? last.glyph : line.glyphs.length - 1;
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    for (let glyph = start; glyph <= end; glyph++) {
      x0 = Math.min(x0, line.glyphs[glyph][0]);
      x1 = Math.max(x1, line.glyphs[glyph][1]);
    }
    const top = line.bbox[1];
    const bottom = line.bbox[3];
    if (x0 >= x1 || top >= bottom) continue;
    // QuadPoints run top-left, top-right, bottom-left, bottom-right as the text is read.
    const tl = displayToPdf([x0, top], size);
    const tr = displayToPdf([x1, top], size);
    const bl = displayToPdf([x0, bottom], size);
    const br = displayToPdf([x1, bottom], size);
    quads.push([...tl, ...tr, ...bl, ...br]);
    corners.push(tl, tr, bl, br);
  }
  return { rect: bounds(corners), quads };
}

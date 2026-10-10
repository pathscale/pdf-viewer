// Display space to PDF default user space, and the reverse.
//
// Order from the pointer to an annotation rectangle:
//   1. undo view zoom (the caller maps the pointer onto the rotated page box)
//   2. undo clockwise page rotation
//   3. divide by UserUnit
//   4. add the crop box origin
// Drawing existing annotations reverses steps 4, 3, and 2. The SVG viewBox
// applies the zoom.
//
// Display space has its origin at the top-left and y downward. Its axes are
// page_size, the crop box multiplied by UserUnit U. PDF space has its origin
// at the bottom-left and y upward. (W, H) is the unrotated display size.
// Crop origin (ox, oy) is in default user space.
//   0:   (ox + x/U,       oy + (H - y)/U)
//   90:  (ox + y/U,       oy + x/U)
//   180: (ox + (W - x)/U, oy + y/U)
//   270: (ox + (W - y)/U, oy + (H - x)/U)

import type { Bbox, PageDimensions, PageSize, Point } from "./api";
import { clamp } from "./preferences";

export function unrotatedSize(size: PageSize): PageDimensions {
  return size.rotate === 90 || size.rotate === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

function space(size: PageSize) {
  const { width, height } = unrotatedSize(size);
  const [ox, oy] = size.origin;
  return { width, height, unit: size.user_unit, ox, oy };
}

export function displayToPdf(point: Point, size: PageSize): Point {
  const { width, height, unit, ox, oy } = space(size);
  const x = clamp(point[0], 0, size.width);
  const y = clamp(point[1], 0, size.height);
  switch (size.rotate) {
    case 90:
      return [ox + y / unit, oy + x / unit];
    case 180:
      return [ox + (width - x) / unit, oy + y / unit];
    case 270:
      return [ox + (width - y) / unit, oy + (height - x) / unit];
    default:
      return [ox + x / unit, oy + (height - y) / unit];
  }
}

export function pdfToDisplay(point: Point, size: PageSize): Point {
  const { width, height, unit, ox, oy } = space(size);
  const x = (point[0] - ox) * unit;
  const y = (point[1] - oy) * unit;
  switch (size.rotate) {
    case 90:
      return [y, x];
    case 180:
      return [width - x, y];
    case 270:
      return [height - y, width - x];
    default:
      return [x, height - y];
  }
}

export function bounds(points: Point[], padding = 0): Bbox {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0 - padding, y0 - padding, x1 + padding, y1 + padding];
}

export function displayRect(rect: Bbox, size: PageSize): Bbox {
  return bounds([
    pdfToDisplay([rect[0], rect[1]], size),
    pdfToDisplay([rect[0], rect[3]], size),
    pdfToDisplay([rect[2], rect[1]], size),
    pdfToDisplay([rect[2], rect[3]], size),
  ]);
}

// Note icon is 20 default-user-space units, click on the top edge, inside the crop box.
export function noteRect(point: Point, size: PageSize): Bbox {
  const { width, height, unit, ox, oy } = space(size);
  const pageWidth = width / unit;
  const pageHeight = height / unit;
  const x = clamp(point[0], ox, ox + Math.max(0, pageWidth - 20));
  const y = clamp(point[1], oy + Math.min(20, pageHeight), oy + pageHeight);
  return [x, y - 20, x + 20, y];
}

export function pdfTransform(size: PageSize): string {
  const { width, height, unit, ox, oy } = space(size);
  const sx = unit * ox;
  const sy = unit * oy;
  switch (size.rotate) {
    case 90:
      return `matrix(0 ${unit} ${unit} 0 ${-sy} ${-sx})`;
    case 180:
      return `matrix(${-unit} 0 0 ${unit} ${width + sx} ${-sy})`;
    case 270:
      return `matrix(0 ${-unit} ${-unit} 0 ${height + sy} ${width + sx})`;
    default:
      return `matrix(${unit} 0 0 ${-unit} ${-sx} ${height + sy})`;
  }
}


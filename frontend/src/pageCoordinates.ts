import type { Bbox, PageDimensions, PageSize, Point } from "./api";
import { clamp } from "./preferences";

export function unrotatedSize(size: PageSize): PageDimensions {
  return size.rotate === 90 || size.rotate === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

// Display coordinates have their origin at the top-left. PDF coordinates have
// their origin at the bottom-left, before the page's clockwise rotation.
export function displayToPdf(point: Point, size: PageSize): Point {
  const { width, height } = unrotatedSize(size);
  const x = clamp(point[0], 0, size.width);
  const y = clamp(point[1], 0, size.height);
  switch (size.rotate) {
    case 90:
      return [y, x];
    case 180:
      return [width - x, y];
    case 270:
      return [width - y, height - x];
    default:
      return [x, height - y];
  }
}

export function pdfToDisplay(point: Point, size: PageSize): Point {
  const { width, height } = unrotatedSize(size);
  switch (size.rotate) {
    case 90:
      return [point[1], point[0]];
    case 180:
      return [width - point[0], point[1]];
    case 270:
      return [height - point[1], width - point[0]];
    default:
      return [point[0], height - point[1]];
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

export function pdfTransform(size: PageSize): string {
  const { width, height } = unrotatedSize(size);
  switch (size.rotate) {
    case 90:
      return "matrix(0 1 1 0 0 0)";
    case 180:
      return `matrix(-1 0 0 1 ${width} 0)`;
    case 270:
      return `matrix(0 -1 -1 0 ${height} ${width})`;
    default:
      return `matrix(1 0 0 -1 0 ${height})`;
  }
}

import type {
  DocumentInfo,
  PageRaster,
  SearchHit,
  SemanticPage,
  SemanticSpan,
  ViewerApi,
} from "./client";

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
const MAX_PIXELS = 16_000_000;

function span(text: string, changes: Partial<SemanticSpan> = {}): SemanticSpan {
  return {
    text,
    bold: false,
    italic: false,
    monospace: false,
    size: 12,
    link: null,
    ...changes,
  };
}

export function createMockApi(): ViewerApi {
  let opened = false;
  const listeners = new Set<(info: DocumentInfo) => void>();

  const pages: SemanticPage[] = [
    {
      index: 0,
      width: 612,
      height: 792,
      refusal: null,
      blocks: [
        {
          kind: "heading",
          level: 1,
          bbox: [54, 48, 558, 82],
          spans: [span("A small PDF", { bold: true, size: 24 })],
        },
        {
          kind: "paragraph",
          bbox: [54, 100, 558, 146],
          spans: [
            span("This two-page document runs entirely in memory. "),
            span("Reading view", { bold: true }),
            span(" displays semantic text, links and images."),
          ],
        },
        {
          kind: "heading",
          level: 2,
          bbox: [54, 170, 558, 194],
          spans: [span("Try the controls", { bold: true, size: 18 })],
        },
        {
          kind: "list_item",
          bbox: [54, 214, 558, 236],
          spans: [span("Search for document and jump to a result.")],
        },
        {
          kind: "list_item",
          bbox: [54, 242, 558, 264],
          spans: [span("Adjust zoom, font size and the light or dark theme.")],
        },
        {
          kind: "paragraph",
          bbox: [54, 286, 558, 312],
          spans: [span("Continue to page two.", { link: 0 })],
        },
        {
          kind: "caption",
          bbox: [54, 438, 558, 460],
          spans: [span("A placeholder image, supplied without a canvas.", { italic: true })],
        },
      ],
      images: [
        {
          bbox: [54, 332, 254, 422],
          object: "7 0",
          width: 200,
          height: 90,
          inline: false,
        },
      ],
      links: [
        {
          bbox: [54, 286, 250, 312],
          target: { kind: "page", index: 1, y: null },
        },
      ],
    },
    {
      index: 1,
      width: 612,
      height: 792,
      refusal: null,
      blocks: [
        {
          kind: "heading",
          level: 1,
          bbox: [54, 48, 558, 82],
          spans: [span("Reading comfortably", { bold: true, size: 24 })],
        },
        {
          kind: "paragraph",
          bbox: [54, 100, 558, 146],
          spans: [
            span("Your view, zoom and font scale are remembered for this app. "),
            span("The mock page images are intentionally simple.", { italic: true }),
          ],
        },
        {
          kind: "heading",
          level: 3,
          bbox: [54, 170, 558, 194],
          spans: [span("Keyboard shortcuts", { bold: true, size: 15 })],
        },
        {
          kind: "paragraph",
          bbox: [54, 214, 558, 260],
          spans: [
            span("Use "),
            span("Cmd+F", { monospace: true }),
            span(" to search and "),
            span("Cmd+O", { monospace: true }),
            span(" to open. Arrow keys and PageUp/PageDown change pages."),
          ],
        },
        {
          kind: "paragraph",
          bbox: [54, 286, 558, 312],
          spans: [span("Return to the first page.", { link: 0 })],
        },
        {
          kind: "paragraph",
          bbox: [54, 332, 558, 358],
          spans: [span("Read about the PDF format.", { link: 1 })],
        },
      ],
      images: [],
      links: [
        {
          bbox: [54, 286, 300, 312],
          target: { kind: "page", index: 0, y: null },
        },
        {
          bbox: [54, 332, 300, 358],
          target: { kind: "uri", uri: "https://www.pdfa.org/" },
        },
      ],
    },
  ];

  function requirePage(index: number): SemanticPage {
    if (!opened) throw new Error("Open a document first");
    const page = Number.isInteger(index) ? pages[index] : undefined;
    if (!page) throw new Error(`Page index ${index} is out of range`);
    return page;
  }

  function raster(index: number, scale: number): PageRaster {
    const page = requirePage(index);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("Scale must be positive");
    const bounded = Math.min(scale, Math.sqrt(MAX_PIXELS / (page.width * page.height)));
    return {
      width: Math.max(1, Math.floor(page.width * bounded)),
      height: Math.max(1, Math.floor(page.height * bounded)),
      png: PIXEL,
    };
  }

  function open(title: string): DocumentInfo {
    opened = true;
    const info: DocumentInfo = {
      title,
      pages: pages.length,
      encrypted: false,
      outline: [
        { title: "A small PDF", level: 0, page: 0 },
        { title: "Reading comfortably", level: 1, page: 1 },
      ],
    };
    for (const listener of listeners) listener(info);
    return info;
  }

  return {
    async openFile(path) {
      const trimmed = path.trim();
      if (!trimmed) throw new Error("Enter a file path");
      return open(trimmed.split(/[\\/]/).pop() || "A small PDF");
    },
    async pickAndOpen() {
      return open("A small PDF");
    },
    async pageSize(index) {
      const page = requirePage(index);
      return { width: page.width, height: page.height };
    },
    async renderPage(index, scale) {
      return raster(index, scale);
    },
    async semanticPage(index) {
      return requirePage(index);
    },
    async pageImage(object) {
      if (!opened) throw new Error("Open a document first");
      if (object !== "7 0") throw new Error(`Image object ${object} is unavailable`);
      return { mime: "image/png", data: PIXEL };
    },
    async search(query, max) {
      if (!opened) throw new Error("Open a document first");
      const needle = query.trim().toLocaleLowerCase();
      if (!needle || !Number.isFinite(max) || max <= 0) return [];
      const limit = Math.min(200, Math.floor(max));
      const hits: SearchHit[] = [];
      for (const page of pages) {
        for (const block of page.blocks) {
          const text = block.spans.map((part) => part.text).join("");
          const lower = text.toLocaleLowerCase();
          let from = 0;
          while (hits.length < limit) {
            const position = lower.indexOf(needle, from);
            if (position < 0) break;
            hits.push({
              page: page.index,
              snippet: text.slice(Math.max(0, position - 40), position + needle.length + 80),
              bbox: block.bbox,
            });
            from = position + needle.length;
          }
          if (hits.length === limit) return hits;
        }
      }
      return hits;
    },
    async thumbnail(index) {
      const page = requirePage(index);
      return raster(index, 160 / page.width);
    },
    async on(_event, handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}


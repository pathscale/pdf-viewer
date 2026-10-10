import type {
  Annotation,
  AnnotationKind,
  DocumentInfo,
  DocumentProperties,
  EditState,
  PageRaster,
  PageSize,
  Rotation,
  SearchHit,
  SemanticPage,
  SemanticSpan,
  Unlisten,
  ViewerApi,
  ViewerEvents,
} from "./client";

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
const MAX_PIXELS = 16_000_000;
const MAX_HISTORY = 100;
const MAX_PAGES = 256;

const SUBTYPES: Record<AnnotationKind, string> = {
  highlight: "Highlight",
  note: "Text",
  ink: "Ink",
  free_text: "FreeText",
  square: "Square",
  circle: "Circle",
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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

interface Snapshot {
  pages: SemanticPage[];
  rotations: Rotation[];
  marks: Annotation[][];
  properties: DocumentProperties;
}

export function createMockApi(): ViewerApi {
  let opened = false;
  const listeners: {
    [K in keyof ViewerEvents]: Set<(payload: ViewerEvents[K]) => void>;
  } = {
    document_opened: new Set(),
    document_changed: new Set(),
  };

  const initialPages: SemanticPage[] = [
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

  let pages = clone(initialPages);
  let rotations: Rotation[] = pages.map(() => 0);
  let marks: Annotation[][] = [];
  let properties: DocumentProperties = {
    title: null,
    author: null,
    subject: null,
    keywords: null,
  };
  let path = "/preview/document.pdf";
  let saved = "";
  const undo: string[] = [];
  const redo: string[] = [];

  function emit<K extends keyof ViewerEvents>(event: K, payload: ViewerEvents[K]): void {
    const handlers = listeners[event] as Set<(payload: ViewerEvents[K]) => void>;
    for (const listener of handlers) listener(payload);
  }

  function requireOpen(): void {
    if (!opened) throw new Error("Open a document first");
  }

  function requirePage(index: number): SemanticPage {
    if (!opened) throw new Error("Open a document first");
    const page = Number.isInteger(index) ? pages[index] : undefined;
    if (!page) throw new Error(`Page index ${index} is out of range`);
    return page;
  }

  function linkMarks(page: SemanticPage): Annotation[] {
    return page.links.map((link, index) => ({
      index,
      subtype: "Link",
      rect: [link.bbox[0], page.height - link.bbox[3], link.bbox[2], page.height - link.bbox[1]],
      contents: null,
      color: null,
    }));
  }

  function snapshot(): string {
    return JSON.stringify({ pages, rotations, marks, properties } satisfies Snapshot);
  }

  function restore(value: string): void {
    const state = JSON.parse(value) as Snapshot;
    pages = state.pages;
    rotations = state.rotations;
    marks = state.marks;
    properties = state.properties;
  }

  function editState(): EditState {
    requireOpen();
    return {
      dirty: snapshot() !== saved,
      can_undo: undo.length > 0,
      can_redo: redo.length > 0,
      path,
    };
  }

  function reindex(): void {
    const order = new Map(pages.map((page, index) => [page.index, index]));
    for (const [index, page] of pages.entries()) {
      page.index = index;
      for (const link of page.links) {
        const target = link.target;
        const old = target.index ?? target.page;
        if (old === undefined || !order.has(old)) continue;
        if (target.index !== undefined) target.index = order.get(old);
        else target.page = order.get(old);
      }
    }
  }

  function changed(): void {
    emit("document_changed", { pages: pages.length });
  }

  function change(work: () => void): void {
    requireOpen();
    const before = snapshot();
    try {
      work();
      reindex();
    } catch (reason) {
      restore(before);
      throw reason;
    }
    if (snapshot() === before) return;
    undo.push(before);
    if (undo.length > MAX_HISTORY) undo.shift();
    redo.length = 0;
    changed();
  }

  function displaySize(index: number): PageSize {
    const page = requirePage(index);
    const rotate = rotations[index] || 0;
    const swapped = rotate === 90 || rotate === 270;
    return {
      width: swapped ? page.height : page.width,
      height: swapped ? page.width : page.height,
      rotate,
    };
  }

  function raster(index: number, scale: number): PageRaster {
    const page = displaySize(index);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("Scale must be positive");
    const bounded = Math.min(scale, Math.sqrt(MAX_PIXELS / (page.width * page.height)));
    return {
      width: Math.max(1, Math.floor(page.width * bounded)),
      height: Math.max(1, Math.floor(page.height * bounded)),
      png: PIXEL,
    };
  }

  function open(title: string, filePath = "/preview/document.pdf"): DocumentInfo {
    opened = true;
    pages = clone(initialPages);
    rotations = pages.map(() => 0);
    marks = pages.map(linkMarks);
    properties = { title, author: null, subject: null, keywords: null };
    path = filePath;
    undo.length = 0;
    redo.length = 0;
    saved = snapshot();
    const info: DocumentInfo = {
      title,
      pages: pages.length,
      encrypted: false,
      outline: [
        { title: "A small PDF", level: 0, page: 0 },
        { title: "Reading comfortably", level: 1, page: 1 },
      ],
    };
    emit("document_opened", info);
    return info;
  }

  return {
    async openFile(path) {
      const trimmed = path.trim();
      if (!trimmed) throw new Error("Enter a file path");
      return open(trimmed.split(/[\\/]/).pop() || "A small PDF", trimmed);
    },
    async pickAndOpen() {
      return open("A small PDF");
    },
    async pageSize(index) {
      return displaySize(index);
    },
    async renderPage(index, scale) {
      return raster(index, scale);
    },
    async semanticPage(index) {
      return clone(requirePage(index));
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
      const page = displaySize(index);
      return raster(index, 160 / page.width);
    },
    async editState() {
      return editState();
    },
    async annotations(index) {
      requirePage(index);
      return clone(marks[index] || []);
    },
    async annotate(input) {
      requirePage(input.index);
      if (
        !SUBTYPES[input.kind] ||
        !input.rect.every(Number.isFinite) ||
        input.rect[2] <= input.rect[0] ||
        input.rect[3] <= input.rect[1] ||
        !input.color.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
        !Number.isFinite(input.opacity) ||
        input.opacity < 0 ||
        input.opacity > 1
      ) {
        throw new Error("Invalid annotation");
      }
      if (
        input.kind === "highlight" &&
        (!input.quads?.length ||
          input.quads.some((quad) => quad.length !== 8 || !quad.every(Number.isFinite)))
      ) {
        throw new Error("Highlight needs finite quadrilaterals");
      }
      if (
        input.kind === "ink" &&
        (!input.paths?.length ||
          input.paths.some(
            (stroke) =>
              stroke.length < 2 ||
              stroke.some((point) => point.length !== 2 || !point.every(Number.isFinite)),
          ))
      ) {
        throw new Error("Ink needs finite paths");
      }
      if (
        (input.width !== undefined && (!Number.isFinite(input.width) || input.width <= 0)) ||
        (input.size !== undefined && (!Number.isFinite(input.size) || input.size <= 0))
      ) {
        throw new Error("Width and size must be positive");
      }
      const annotation = marks[input.index]?.length || 0;
      change(() => {
        const list = marks[input.index] || [];
        list.push({
          index: annotation,
          subtype: SUBTYPES[input.kind],
          rect: clone(input.rect),
          contents: input.contents ?? input.text ?? null,
          color: clone(input.color),
          preview: clone(input),
        });
        marks[input.index] = list;
      });
      return { annotation };
    },
    async removeAnnotation(index, annotation) {
      const page = requirePage(index);
      const list = marks[index] || [];
      if (!Number.isInteger(annotation) || !list[annotation]) {
        throw new Error("Annotation index is out of range");
      }
      change(() => {
        if (list[annotation].subtype === "Link") {
          const linkIndex = list
            .slice(0, annotation)
            .filter((item) => item.subtype === "Link").length;
          page.links.splice(linkIndex, 1);
          for (const block of page.blocks) {
            for (const part of block.spans) {
              if (part.link === linkIndex) part.link = null;
              else if (part.link !== null && part.link > linkIndex) part.link--;
            }
          }
        }
        list.splice(annotation, 1);
        list.forEach((item, position) => {
          item.index = position;
        });
      });
    },
    async rotatePage(index, quarterTurns) {
      requirePage(index);
      if (!Number.isSafeInteger(quarterTurns)) throw new Error("Rotation must be integral");
      change(() => {
        rotations[index] = (((rotations[index] || 0) + (quarterTurns % 4) * 90 + 360) %
          360) as Rotation;
      });
    },
    async deletePage(index) {
      requirePage(index);
      if (pages.length === 1) throw new Error("Cannot delete the last page");
      change(() => {
        pages.splice(index, 1);
        rotations.splice(index, 1);
        marks.splice(index, 1);
      });
    },
    async movePage(from, to) {
      requirePage(from);
      requirePage(to);
      change(() => {
        const page = pages.splice(from, 1)[0];
        const rotate = rotations.splice(from, 1)[0];
        const annotations = marks.splice(from, 1)[0];
        pages.splice(to, 0, page);
        rotations.splice(to, 0, rotate);
        marks.splice(to, 0, annotations);
      });
    },
    async insertPdf(sourcePath, at) {
      requireOpen();
      if (!sourcePath.trim()) throw new Error("Enter a PDF path");
      if (!Number.isInteger(at) || at < 0 || at > pages.length) {
        throw new Error("Insertion position is out of range");
      }
      if (pages.length + initialPages.length > MAX_PAGES) {
        throw new Error(`Page limit is ${MAX_PAGES}`);
      }
      change(() => {
        const imported = clone(initialPages);
        const offset = pages.length;
        for (const page of imported) {
          page.index += offset;
          for (const link of page.links) {
            if (link.target.index !== undefined) link.target.index += offset;
            else if (link.target.page !== undefined) link.target.page += offset;
          }
        }
        const first = imported[0]?.blocks[0]?.spans[0];
        if (first) first.text = `Inserted: ${sourcePath.split(/[\\/]/).pop() || "PDF"}`;
        pages.splice(at, 0, ...imported);
        rotations.splice(at, 0, ...imported.map(() => 0 as Rotation));
        marks.splice(at, 0, ...imported.map(linkMarks));
      });
    },
    async info() {
      requireOpen();
      return clone(properties);
    },
    async setInfo(key, text) {
      const field = {
        Title: "title",
        Author: "author",
        Subject: "subject",
        Keywords: "keywords",
      }[key] as keyof DocumentProperties;
      change(() => {
        properties[field] = text || null;
      });
    },
    async undo() {
      requireOpen();
      const previous = undo.pop();
      if (previous !== undefined) {
        redo.push(snapshot());
        restore(previous);
        changed();
      }
      return editState();
    },
    async redo() {
      requireOpen();
      const next = redo.pop();
      if (next !== undefined) {
        undo.push(snapshot());
        restore(next);
        changed();
      }
      return editState();
    },
    async save(mode) {
      requireOpen();
      if (mode === "copy") {
        path = /\.pdf$/i.test(path) ? path.replace(/\.pdf$/i, ".edited.pdf") : `${path}.edited.pdf`;
      }
      saved = snapshot();
      return { path };
    },
    async on<K extends keyof ViewerEvents>(
      event: K,
      handler: (payload: ViewerEvents[K]) => void,
    ): Promise<Unlisten> {
      const handlers = listeners[event] as Set<(payload: ViewerEvents[K]) => void>;
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

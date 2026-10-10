export type Unlisten = () => void;
export type Bbox = [number, number, number, number];
export type Point = [number, number];
export type Rotation = 0 | 90 | 180 | 270;
export type Color = [number, number, number];

export interface OutlineItem {
  title: string;
  level: number;
  page: number | null;
}

export interface DocumentInfo {
  title: string | null;
  pages: number;
  encrypted: boolean;
  outline: OutlineItem[];
}

export interface PageDimensions {
  width: number;
  height: number;
}

// Width and height are the rotated display dimensions: crop box size times
// UserUnit. origin is the crop box lower-left in default user space.
export interface PageSize extends PageDimensions {
  rotate: Rotation;
  origin: Point;
  user_unit: number;
}

export interface PageRaster extends PageDimensions {
  png: string;
}

export interface PageImage {
  mime: "image/jpeg" | "image/png";
  data: string;
}

export interface SearchHit {
  page: number;
  snippet: string;
  bbox: Bbox;
}

export interface SemanticSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
  size: number;
  link: number | null;
  style?: {
    bold: boolean;
    italic: boolean;
    monospace: boolean;
  };
}

export interface SemanticBlock {
  kind: string | { heading: number };
  level?: number;
  bbox: Bbox;
  spans: SemanticSpan[];
}

// Keep the wire payload intact. Both explicit kind/index targets and flat
// uri/page targets can be displayed without rewriting semantic_page replies.
export interface LinkTarget {
  kind?: string;
  uri?: string;
  index?: number;
  page?: number;
  y?: number | null;
}

export interface SemanticLink {
  bbox: Bbox;
  target: LinkTarget;
}

export interface SemanticImageRef {
  bbox: Bbox;
  object: string | null;
  width: number;
  height: number;
  inline: boolean;
}

export interface SemanticPage extends PageDimensions {
  index: number;
  blocks: SemanticBlock[];
  images: SemanticImageRef[];
  links: SemanticLink[];
  refusal: string | null;
}

export type AnnotationKind = "highlight" | "note" | "ink" | "free_text" | "square" | "circle";

export interface AnnotationInput {
  index: number;
  kind: AnnotationKind;
  rect: Bbox;
  color: Color;
  opacity: number;
  contents?: string;
  quads?: [number, number, number, number, number, number, number, number][];
  paths?: Point[][];
  width?: number;
  text?: string;
  size?: number;
}

export interface Annotation {
  index: number;
  subtype: string;
  rect: Bbox;
  contents: string | null;
  color: Color | null;
  // In-memory mock only. Native appearances are drawn by render_page.
  preview?: AnnotationInput;
}

export interface EditState {
  dirty: boolean;
  can_undo: boolean;
  can_redo: boolean;
  path: string | null;
}

export interface DocumentProperties {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
}

export type InfoKey = "Title" | "Author" | "Subject" | "Keywords";
export type SaveMode = "in_place" | "copy";

export interface ViewerEvents {
  document_opened: DocumentInfo;
  document_changed: { pages: number };
}

export interface ViewerApi {
  openFile(path: string): Promise<DocumentInfo>;
  pickAndOpen(): Promise<DocumentInfo>;
  pageSize(index: number): Promise<PageSize>;
  renderPage(index: number, scale: number): Promise<PageRaster>;
  semanticPage(index: number): Promise<SemanticPage>;
  pageImage(object: string): Promise<PageImage>;
  search(query: string, max: number): Promise<SearchHit[]>;
  thumbnail(index: number): Promise<PageRaster>;
  editState(): Promise<EditState>;
  annotations(index: number): Promise<Annotation[]>;
  annotate(input: AnnotationInput): Promise<{ annotation: unknown }>;
  removeAnnotation(index: number, annotation: number): Promise<void>;
  rotatePage(index: number, quarterTurns: number): Promise<void>;
  deletePage(index: number): Promise<void>;
  movePage(from: number, to: number): Promise<void>;
  insertPdf(path: string, at: number): Promise<void>;
  info(): Promise<DocumentProperties>;
  setInfo(key: InfoKey, text: string): Promise<void>;
  undo(): Promise<EditState>;
  redo(): Promise<EditState>;
  save(mode: SaveMode): Promise<{ path: string }>;
  on<K extends keyof ViewerEvents>(
    event: K,
    handler: (payload: ViewerEvents[K]) => void,
  ): Promise<Unlisten>;
}


export type Unlisten = () => void;
export type Bbox = [number, number, number, number];

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

export interface PageSize {
  width: number;
  height: number;
}

export interface PageRaster extends PageSize {
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

export interface SemanticPage extends PageSize {
  index: number;
  blocks: SemanticBlock[];
  images: SemanticImageRef[];
  links: SemanticLink[];
  refusal: string | null;
}

export interface ViewerEvents {
  document_opened: DocumentInfo;
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
  on<K extends keyof ViewerEvents>(
    event: K,
    handler: (payload: ViewerEvents[K]) => void,
  ): Promise<Unlisten>;
}


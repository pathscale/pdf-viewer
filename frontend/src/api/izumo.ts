import type {
  Annotation,
  DocumentInfo,
  DocumentProperties,
  EditState,
  PageImage,
  PageRaster,
  PageSize,
  SearchHit,
  SemanticPage,
  TextLine,
  Unlisten,
  ViewerApi,
  ViewerEvents,
} from "./client";

interface IzumoEvent<T> {
  event: string;
  id: number;
  payload: T;
}

interface IzumoBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (message: IzumoEvent<T>) => void): Promise<Unlisten>;
}

declare global {
  interface Window {
    __IZUMO__?: IzumoBridge;
  }
}

export function createIzumoApi(): ViewerApi {
  const izumo = window.__IZUMO__;
  if (!izumo) throw new Error("The izumo IPC bridge is unavailable");

  return {
    openFile: (path) => izumo.invoke<DocumentInfo>("open_file", { path }),
    pickAndOpen: () => izumo.invoke<DocumentInfo>("pick_and_open", {}),
    pageSize: (index) => izumo.invoke<PageSize>("page_size", { index }),
    renderPage: (index, scale) => izumo.invoke<PageRaster>("render_page", { index, scale }),
    semanticPage: (index) => izumo.invoke<SemanticPage>("semantic_page", { index }),
    textLines: (index) => izumo.invoke<TextLine[]>("text_lines", { page_index: index }),
    pageImage: (object) => izumo.invoke<PageImage>("page_image", { object }),
    search: (query, max) => izumo.invoke<SearchHit[]>("search", { query, max }),
    thumbnail: (index) => izumo.invoke<PageRaster>("thumbnail", { index }),
    editState: () => izumo.invoke<EditState>("edit_state", {}),
    annotations: (index) => izumo.invoke<Annotation[]>("annotations", { index }),
    annotate: (input) => izumo.invoke<{ annotation: unknown }>("annotate", { ...input }),
    removeAnnotation: (index, annotation) =>
      izumo.invoke<void>("remove_annotation", { index, annotation }),
    rotatePage: (index, quarterTurns) =>
      izumo.invoke<void>("rotate_page", { index, quarter_turns: quarterTurns }),
    deletePage: (index) => izumo.invoke<void>("delete_page", { index }),
    movePage: (from, to) => izumo.invoke<void>("move_page", { from, to }),
    insertPdf: (path, at) => izumo.invoke<void>("insert_pdf", { path, at }),
    info: () => izumo.invoke<DocumentProperties>("info", {}),
    setInfo: (key, text) => izumo.invoke<void>("set_info", { key, text }),
    undo: () => izumo.invoke<EditState>("undo", {}),
    redo: () => izumo.invoke<EditState>("redo", {}),
    save: (mode) => izumo.invoke<{ path: string }>("save", { mode }),
    on<K extends keyof ViewerEvents>(
      event: K,
      handler: (payload: ViewerEvents[K]) => void,
    ): Promise<Unlisten> {
      return izumo.listen<ViewerEvents[K]>(event, (message) => handler(message.payload));
    },
  };
}

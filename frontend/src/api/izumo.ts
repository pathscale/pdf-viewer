import type {
  DocumentInfo,
  PageImage,
  PageRaster,
  PageSize,
  SearchHit,
  SemanticPage,
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
  listen<T>(
    event: string,
    handler: (message: IzumoEvent<T>) => void,
  ): Promise<Unlisten>;
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
    renderPage: (index, scale) =>
      izumo.invoke<PageRaster>("render_page", { index, scale }),
    semanticPage: (index) => izumo.invoke<SemanticPage>("semantic_page", { index }),
    pageImage: (object) => izumo.invoke<PageImage>("page_image", { object }),
    search: (query, max) => izumo.invoke<SearchHit[]>("search", { query, max }),
    thumbnail: (index) => izumo.invoke<PageRaster>("thumbnail", { index }),
    on<K extends keyof ViewerEvents>(
      event: K,
      handler: (payload: ViewerEvents[K]) => void,
    ): Promise<Unlisten> {
      return izumo.listen<ViewerEvents[K]>(event, (message) => handler(message.payload));
    },
  };
}


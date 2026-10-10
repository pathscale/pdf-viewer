import { Button } from "@pathscale/ui";
import { createSignal, onSettled } from "solid-js";
import { api } from "../api";
import type { PageRaster, PageSize, SearchHit, SemanticPage } from "../api";
import type { Preferences } from "../preferences";
import { deviceScale, message, observeNear, schedule } from "../runtime";
import { SemanticContent } from "./SemanticContent";

interface PageProps {
  index: number;
  root: () => HTMLElement;
  preferences: () => Preferences;
  hit: () => SearchHit | null;
  subscribe: (handler: () => void) => () => void;
  onSize: (index: number, size: PageSize) => void;
  navigate: (index: number) => void;
}

const POINTS_TO_REM = 96 / 72 / 16;
const MAX_PIXELS = 16_000_000;

export function Page(props: PageProps) {
  const [size, setSize] = createSignal<PageSize>({ width: 612, height: 792 });
  const [raster, setRaster] = createSignal<PageRaster | null>(null);
  const [semantic, setSemantic] = createSignal<SemanticPage | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let section!: HTMLElement;
  let retry = () => {};

  onSettled(() => {
    let disposed = false;
    let near = false;
    let revision = 0;
    let hasSize = false;
    let pendingKey = "";
    let completedKey = "";

    async function load(force = false): Promise<void> {
      if (disposed || !near) return;
      const preferences = props.preferences();
      const key = `${preferences.view}:${preferences.zoom}:${preferences.fontScale}:${deviceScale()}`;
      if (!force && pendingKey === key) return;
      if (!force && preferences.view === "reading" && semantic()) return;
      if (!force && preferences.view === "pages" && raster() && completedKey === key) return;

      const ticket = ++revision;
      const valid = () => !disposed && near && ticket === revision;
      pendingKey = key;
      setError("");
      setBusy(true);
      if (preferences.view === "reading") setRaster(null);

      try {
        if (!hasSize) {
          const dimensions = await schedule(() => api.pageSize(props.index), valid);
          if (!valid()) return;
          if (
            !Number.isFinite(dimensions.width) ||
            !Number.isFinite(dimensions.height) ||
            dimensions.width <= 0 ||
            dimensions.height <= 0
          ) {
            throw new Error("The page has invalid dimensions");
          }
          hasSize = true;
          setSize(dimensions);
          props.onSize(props.index, dimensions);
          if (!valid()) return;
        }

        if (preferences.view === "reading") {
          const page = await schedule(() => api.semanticPage(props.index), valid);
          if (valid()) setSemantic(page);
        } else {
          const dimensions = size();
          const requested =
            preferences.zoom * preferences.fontScale * (96 / 72) * deviceScale();
          const scale = Math.min(
            requested,
            Math.sqrt(MAX_PIXELS / (dimensions.width * dimensions.height)),
          );
          const image = await schedule(() => api.renderPage(props.index, scale), valid);
          if (valid()) setRaster(image);
        }
        if (valid()) completedKey = key;
      } catch (reason) {
        if (valid()) setError(message(reason));
      } finally {
        if (valid()) {
          pendingKey = "";
          setBusy(false);
        }
      }
    }

    const observer = observeNear(section, props.root(), (visible) => {
      near = visible;
      if (visible) {
        void load();
      } else {
        revision++;
        pendingKey = "";
        setRaster(null);
        setBusy(false);
      }
    });
    const unsubscribe = props.subscribe(() => {
      observer.check();
      if (near) void load();
    });
    retry = () => {
      void load(true);
    };

    return () => {
      disposed = true;
      revision++;
      unsubscribe();
      observer.dispose();
      retry = () => {};
    };
  });

  const hitStyle = () => {
    const hit = props.hit();
    const dimensions = size();
    if (!hit || hit.page !== props.index) return undefined;
    const [x0, y0, x1, y1] = hit.bbox;
    return {
      left: `${(x0 / dimensions.width) * 100}%`,
      top: `${(y0 / dimensions.height) * 100}%`,
      width: `${(Math.max(0, x1 - x0) / dimensions.width) * 100}%`,
      height: `${(Math.max(0, y1 - y0) / dimensions.height) * 100}%`,
    };
  };

  return (
    <section
      id={`page-${props.index + 1}`}
      data-page-index={props.index}
      class="document-page"
      aria-label={`Page ${props.index + 1}`}
      ref={(element) => {
        section = element;
      }}
    >
      {props.preferences().view === "pages" ? (
        <figure class="raster-figure">
          <div
            class="page-paper"
            aria-busy={busy() ? "true" : "false"}
            style={{
              width: `${size().width * POINTS_TO_REM * props.preferences().zoom}rem`,
              height: `${size().height * POINTS_TO_REM * props.preferences().zoom}rem`,
            }}
          >
            {raster() ? (
              <img
                class="page-raster"
                src={`data:image/png;base64,${raster()?.png}`}
                alt={`Rendered PDF page ${props.index + 1}`}
                draggable={false}
              />
            ) : (
              <div class="page-placeholder">
                {busy() ? "Rendering page..." : error() || `Page ${props.index + 1}`}
              </div>
            )}
            {props.hit()?.page === props.index ? (
              <span class="search-highlight" style={hitStyle()} aria-hidden="true" />
            ) : null}
          </div>
          <figcaption class="page-number">Page {props.index + 1}</figcaption>
        </figure>
      ) : (
        <article
          class="reading-page"
          aria-busy={busy() ? "true" : "false"}
          style={{ "font-size": `${props.preferences().zoom}em` }}
        >
          <div class="reading-page-break">Page {props.index + 1}</div>
          {semantic() ? (
            <SemanticContent
              page={semantic() as SemanticPage}
              root={props.root}
              navigate={props.navigate}
            />
          ) : (
            <div class="reading-placeholder">
              {busy() ? "Loading text..." : error() || "Text loads as this page comes into view."}
            </div>
          )}
          {props.hit()?.page === props.index ? (
            <p class="reading-search-hit" role="status">
              {props.hit()?.snippet}
            </p>
          ) : null}
        </article>
      )}
      {error() ? (
        <div class="page-error" role="status">
          <span>{error()}</span>
          <Button type="button" class="viewer-button" onClick={() => retry()}>
            Retry page
          </Button>
        </div>
      ) : null}
    </section>
  );
}


import { Button } from "@pathscale/ui";
import { createSignal, onSettled } from "solid-js";
import type { DocumentInfo, PageSize, SearchHit, Unlisten } from "./api";
import { api, isMock } from "./api";
import { EditingToolbar } from "./components/EditingToolbar";
import { AnnotationSidebar, InsertPdf, PropertiesDialog } from "./components/EditorPanels";
import { IconButton } from "./components/IconButton";
import { Page } from "./components/Page";
import { Thumbnail } from "./components/Thumbnail";
import { createEditor } from "./editing";
import type { Preferences } from "./preferences";
import { clamp, DEFAULT_PREFERENCES, readPreferences, savePreferences } from "./preferences";
import { message, schedule } from "./runtime";

const SEARCH_MAX = 200;

export function App() {
  const [preferences, setPreferences] = createSignal(readPreferences());
  const [info, setInfo] = createSignal<DocumentInfo | null>(null);
  const [currentPage, setCurrentPage] = createSignal(0);
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [sidebarTab, setSidebarTab] = createSignal<"outline" | "thumbnails">("outline");
  const [opening, setOpening] = createSignal(false);
  const [error, setError] = createSignal("");
  const [pathPrompt, setPathPrompt] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<SearchHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searched, setSearched] = createSignal(false);
  const [hit, setHit] = createSignal<SearchHit | null>(null);

  const editor = createEditor({
    available: () => !!info() && !info()?.encrypted && !opening(),
    currentPage,
    navigate: jump,
    changed: (pages) => {
      documentRevision++;
      sizes.clear();
      setHit(null);
      setInfo((previous) =>
        previous
          ? { ...previous, pages, outline: pages === previous.pages ? previous.outline : [] }
          : previous,
      );
      const page = clamp(currentPage(), 0, Math.max(0, pages - 1));
      setCurrentPage(page);
      searchChanged(query());
      editor.showPage(page);
      later(() => {
        fitWidth();
        notify();
      });
    },
    organized: () => {
      // The edit event carries only a page count, not remapped outline targets.
      setInfo((previous) => (previous ? { ...previous, outline: [] } : previous));
    },
    title: (title) => {
      setInfo((previous) =>
        previous && previous.title !== title ? { ...previous, title } : previous,
      );
    },
    notify: layoutChanged,
    error: setError,
  });

  const sizes = new Map<number, PageSize>();
  const subscribers = new Set<() => void>();
  const timers = new Set<number>();
  let viewport!: HTMLElement;
  let sidebar!: HTMLElement;
  let searchInput!: HTMLInputElement;
  let pageInput!: HTMLInputElement;
  let pathInput!: HTMLInputElement;
  let disposed = false;
  let documentRevision = 0;
  let searchRevision = 0;
  let searchTimer: number | undefined;
  let scrollTimer: number | undefined;
  let pendingDocument: DocumentInfo | null = null;

  function later(callback: () => void): void {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (!disposed) callback();
    }, 0);
    timers.add(timer);
  }

  function notify(): void {
    for (const subscriber of subscribers) subscriber();
  }

  function subscribe(handler: () => void): () => void {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  }

  function changePreferences(changes: Partial<Preferences>): void {
    const next = { ...preferences(), ...changes };
    setPreferences(next);
    savePreferences(next);
    later(notify);
  }

  function fitWidth(): void {
    if (!preferences().fitWidth || !info() || !viewport) return;
    const dimensions = sizes.get(currentPage()) || { width: 612, height: 792 };
    const style = getComputedStyle(viewport);
    const available =
      viewport.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0);
    const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    if (available <= 0) return;
    const zoom = clamp(available / (dimensions.width * (96 / 72) * (rootSize / 16)), 0.25, 4);
    if (Math.abs(zoom - preferences().zoom) > 0.001) changePreferences({ zoom });
  }

  function onSize(index: number, size: PageSize): void {
    sizes.set(index, size);
    if (index === currentPage()) fitWidth();
  }

  function jump(index: number, selected: SearchHit | null = null): void {
    const count = info()?.pages || 0;
    if (!count || !Number.isInteger(index)) return;
    const target = clamp(index, 0, count - 1);
    setCurrentPage(target);
    setHit(selected);
    fitWidth();
    editor.showPage(target);
    later(() => {
      const page = viewport.querySelector<HTMLElement>(`[data-page-index="${target}"]`);
      if (!page) return;
      const top = page.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      const padding = Number.parseFloat(getComputedStyle(viewport).paddingTop) || 0;
      viewport.scrollTop += top - padding;
      notify();
      viewport.focus({ preventScroll: true });
    });
  }

  function changeView(view: Preferences["view"]): void {
    const page = currentPage();
    if (view === "reading") editor.disable();
    changePreferences({ view });
    later(() => jump(page, hit()));
  }

  function zoomBy(factor: number): void {
    const page = currentPage();
    changePreferences({
      zoom: clamp(preferences().zoom * factor, 0.25, 4),
      fitWidth: false,
    });
    later(() => jump(page, hit()));
  }

  function requestFit(): void {
    changePreferences({ fitWidth: true });
    later(() => {
      fitWidth();
      jump(currentPage(), hit());
    });
  }

  function searchChanged(value: string): void {
    setQuery(value);
    setHit(null);
    setResults([]);
    setSearched(false);
    setSearching(false);
    searchRevision++;
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    searchTimer = undefined;
    const text = value.trim();
    if (!text || !info()) return;
    const ticket = searchRevision;
    const revision = documentRevision;
    setSearching(true);
    searchTimer = window.setTimeout(() => {
      searchTimer = undefined;
      const valid = () => !disposed && ticket === searchRevision && revision === documentRevision;
      void schedule(() => api.search(text, SEARCH_MAX), valid)
        .then((found) => {
          if (!valid()) return;
          setResults(found);
          setSearched(true);
        })
        .catch((reason) => {
          if (valid()) setError(message(reason));
        })
        .finally(() => {
          if (valid()) setSearching(false);
        });
    }, 250);
  }

  function adoptDocument(documentInfo: DocumentInfo): void {
    if (
      !Number.isSafeInteger(documentInfo.pages) ||
      documentInfo.pages < 0 ||
      !Array.isArray(documentInfo.outline)
    ) {
      setError("The document reply is invalid");
      return;
    }
    documentRevision++;
    searchRevision++;
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    searchTimer = undefined;
    sizes.clear();
    setResults([]);
    setQuery("");
    setSearching(false);
    setSearched(false);
    setHit(null);
    setCurrentPage(0);
    setError("");
    setPathPrompt(false);
    setInfo(documentInfo);
    editor.reset();
    // The embedded engine exposes document.title read-only; a throw here would
    // abort the rest of this handler, so the title is best effort.
    try {
      document.title = documentInfo.title ? `${documentInfo.title} | PDF Viewer` : "PDF Viewer";
    } catch {
      // the window title comes from the shell
    }
    later(() => {
      viewport.scrollTop = 0;
      fitWidth();
      notify();
    });
  }

  async function open(path?: string): Promise<void> {
    if (opening() || editor.busy()) return;
    setOpening(true);
    setError("");
    pendingDocument = null;
    try {
      const documentInfo = await schedule(
        () => (path === undefined ? api.pickAndOpen() : api.openFile(path)),
        () => !disposed,
      );
      if (!disposed) adoptDocument(pendingDocument || documentInfo);
    } catch (reason) {
      if (!disposed) {
        if (pendingDocument) adoptDocument(pendingDocument);
        else {
          setError(message(reason));
          setPathPrompt(true);
          later(() => pathInput?.focus());
        }
      }
    } finally {
      pendingDocument = null;
      if (!disposed) setOpening(false);
    }
  }

  function readScroll(): void {
    if (scrollTimer !== undefined) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = undefined;
      if (disposed || !info()) return;
      const bounds = viewport.getBoundingClientRect();
      const anchor = bounds.top + bounds.height * 0.2;
      let candidate = currentPage();
      let distance = Number.POSITIVE_INFINITY;
      for (const page of viewport.querySelectorAll<HTMLElement>("[data-page-index]")) {
        const rectangle = page.getBoundingClientRect();
        const index = Number(page.dataset.pageIndex);
        if (rectangle.top <= anchor && rectangle.bottom >= anchor) {
          candidate = index;
          break;
        }
        const nextDistance = Math.abs(rectangle.top - anchor);
        if (nextDistance < distance) {
          distance = nextDistance;
          candidate = index;
        }
      }
      if (Number.isInteger(candidate)) {
        setCurrentPage(candidate);
        editor.showPage(candidate);
      }
    }, 60);
  }

  function layoutChanged(): void {
    later(() => {
      fitWidth();
      notify();
      window.dispatchEvent(new Event("resize"));
    });
  }

  function keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || editor.keydown(event)) return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === "f") {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (command && key === "o") {
      event.preventDefault();
      void open();
      return;
    }
    if (command && (key === "+" || key === "=")) {
      event.preventDefault();
      zoomBy(1.2);
      return;
    }
    if (command && key === "-") {
      event.preventDefault();
      zoomBy(1 / 1.2);
      return;
    }
    if (command && key === "0") {
      event.preventDefault();
      requestFit();
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.closest("input, textarea, select, button, a, summary"))
    ) {
      return;
    }
    if (event.altKey || command || event.shiftKey) return;
    if (["arrowup", "arrowleft", "pageup"].includes(key)) {
      event.preventDefault();
      jump(currentPage() - 1);
    } else if (["arrowdown", "arrowright", "pagedown"].includes(key)) {
      event.preventDefault();
      jump(currentPage() + 1);
    }
  }

  onSettled(() => {
    let unlisten: Unlisten | undefined;
    window.addEventListener("keydown", keydown);
    const resize = () => {
      fitWidth();
      notify();
    };
    window.addEventListener("resize", resize);
    void api
      .on("document_opened", (documentInfo) => {
        if (disposed) return;
        if (opening()) pendingDocument = documentInfo;
        else adoptDocument(documentInfo);
      })
      .then((stop) => {
        if (disposed) stop();
        else {
          unlisten = stop;
          if (isMock) void open();
        }
      })
      .catch((reason) => {
        if (!disposed) setError(message(reason));
      });

    return () => {
      disposed = true;
      documentRevision++;
      searchRevision++;
      unlisten?.();
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", resize);
      if (searchTimer !== undefined) window.clearTimeout(searchTimer);
      if (scrollTimer !== undefined) window.clearTimeout(scrollTimer);
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      subscribers.clear();
    };
  });

  return (
    <div class="viewer-shell">
      <header class="viewer-toolbar">
        <IconButton
          label={sidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
          glyph="menu"
          pressed={sidebarOpen()}
          onClick={() => {
            setSidebarOpen(!sidebarOpen());
            layoutChanged();
          }}
        />
        <Button
          type="button"
          class="viewer-button"
          title="Open PDF (Cmd+O)"
          disabled={opening()}
          onClick={() => {
            void open();
          }}
        >
          {opening() ? "Opening..." : "Open"}
        </Button>
        <IconButton
          label="Open a PDF by path"
          glyph="open-path"
          onClick={() => {
            setPathPrompt(!pathPrompt());
            if (pathPrompt()) later(() => pathInput?.focus());
          }}
        />
        <IconButton
          glyph="edit"
          label="Edit PDF"
          text="Edit"
          pressed={editor.enabled()}
          disabled={!editor.available() || editor.busy()}
          onClick={() => {
            editor.toggle();
            if (editor.enabled()) {
              changeView("pages");
              setSidebarOpen(true);
              setSidebarTab("thumbnails");
            }
            layoutChanged();
          }}
        />
        <IconButton
          glyph="properties"
          label="Document properties"
          disabled={!editor.available() || editor.busy()}
          onClick={() => {
            void editor.openProperties();
          }}
        />
        <span class="editing-title" title={editor.state().path || info()?.title || "PDF Viewer"}>
          {editor.state().dirty ? "* " : ""}
          {info()?.title || "PDF Viewer"}
        </span>
        <div class="view-switch" role="group" aria-label="Document view">
          <Button
            type="button"
            class="viewer-button"
            aria-pressed={preferences().view === "pages" ? "true" : "false"}
            onClick={() => changeView("pages")}
          >
            Pages
          </Button>
          <Button
            type="button"
            class="viewer-button"
            aria-pressed={preferences().view === "reading" ? "true" : "false"}
            onClick={() => changeView("reading")}
          >
            Reading
          </Button>
        </div>
        <div class="zoom-controls" role="group" aria-label="Zoom">
          <IconButton
            label="Zoom out (Cmd+minus)"
            glyph="−"
            disabled={preferences().zoom <= 0.25}
            onClick={() => zoomBy(1 / 1.2)}
          />
          <output class="zoom-value">{Math.round(preferences().zoom * 100)}%</output>
          <IconButton
            label="Zoom in (Cmd+plus)"
            glyph="+"
            disabled={preferences().zoom >= 4}
            onClick={() => zoomBy(1.2)}
          />
          <IconButton
            label="Fit width (Cmd+0)"
            glyph="fit-width"
            pressed={preferences().fitWidth}
            onClick={requestFit}
          />
        </div>
        <form
          class="page-controls"
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(pageInput.value);
            if (Number.isInteger(value)) jump(value - 1);
            pageInput.value = String(currentPage() + 1);
          }}
        >
          <input
            class="viewer-input page-input"
            type="number"
            min="1"
            max={info()?.pages || 1}
            value={info()?.pages ? currentPage() + 1 : ""}
            disabled={!info()?.pages}
            aria-label="Page number"
            title="Enter a page number"
            ref={(element) => {
              pageInput = element;
            }}
          />
          <span class="muted">/ {info()?.pages || 0}</span>
        </form>
        <div class="search-control">
          <input
            class="viewer-input search-input"
            type="search"
            placeholder="Search document"
            aria-label="Search document"
            title="Search document (Cmd+F)"
            value={query()}
            disabled={!info() || opening()}
            onInput={(event) => searchChanged(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                searchChanged("");
                viewport.focus();
              }
            }}
            ref={(element) => {
              searchInput = element;
            }}
          />
        </div>
        <details class="viewer-settings">
          <summary aria-label="Viewer settings" title="Viewer settings">
            <span aria-hidden="true">⚙</span>
          </summary>
          <div class="settings-panel">
            <label>
              <span>Font size</span>
              <input
                type="range"
                min="0.75"
                max="1.75"
                step="0.05"
                value={preferences().fontScale}
                aria-label="User font size"
                onInput={(event) => {
                  const value = Number(event.currentTarget.value);
                  if (!Number.isFinite(value)) return;
                  changePreferences({ fontScale: clamp(value, 0.75, 1.75) });
                  later(() => {
                    fitWidth();
                    jump(currentPage(), hit());
                  });
                }}
              />
              <output>{Math.round(preferences().fontScale * 100)}%</output>
            </label>
            <label>
              <span>Theme</span>
              <select
                class="viewer-input"
                value={preferences().theme}
                onChange={(event) =>
                  changePreferences({
                    theme: event.currentTarget.value === "dark" ? "dark" : "light",
                  })
                }
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <Button
              type="button"
              class="viewer-button"
              onClick={() => {
                changePreferences({ ...DEFAULT_PREFERENCES });
                later(() => jump(currentPage(), hit()));
              }}
            >
              Reset preferences
            </Button>
          </div>
        </details>
      </header>

      {editor.enabled() ? <EditingToolbar editor={editor} /> : null}
      {editor.propertiesOpen() ? <PropertiesDialog editor={editor} /> : null}

      {pathPrompt() ? (
        <form
          class="path-form"
          onSubmit={(event) => {
            event.preventDefault();
            const path = pathInput.value.trim();
            if (path) void open(path);
          }}
        >
          <input
            type="text"
            class="viewer-input"
            aria-label="PDF file path"
            placeholder="Absolute path to a PDF"
            required
            ref={(element) => {
              pathInput = element;
            }}
          />
          <Button type="submit" class="viewer-button" disabled={opening()}>
            Open path
          </Button>
          <IconButton label="Close path entry" glyph="×" onClick={() => setPathPrompt(false)} />
        </form>
      ) : null}

      {error() ? (
        <div class="error-banner" role="alert">
          <span>{error()}</span>
          <IconButton label="Dismiss error" glyph="×" onClick={() => setError("")} />
        </div>
      ) : null}

      <div class="viewer-workspace">
        <aside
          class="viewer-sidebar"
          aria-label="Document navigation"
          hidden={!sidebarOpen() && !query().trim()}
          ref={(element) => {
            sidebar = element;
          }}
        >
          {query().trim() ? (
            <section class="search-results" aria-label="Search results">
              <div class="sidebar-heading" role="status">
                {searching()
                  ? "Searching..."
                  : searched()
                    ? `${results().length}${results().length === SEARCH_MAX ? "+" : ""} results`
                    : "Search"}
              </div>
              {searched() && results().length === 0 ? (
                <p class="sidebar-empty">No matches.</p>
              ) : null}
              <ol class="search-result-list">
                {results().map((result) => (
                  <li>
                    <button
                      type="button"
                      class="search-result"
                      aria-current={hit() === result ? "location" : undefined}
                      onClick={() => jump(result.page, result)}
                    >
                      <span class="result-page">Page {result.page + 1}</span>
                      <span>{result.snippet}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <>
              <div class="sidebar-tabs" role="tablist" aria-label="Navigation type">
                <button
                  id="outline-tab"
                  type="button"
                  role="tab"
                  aria-selected={sidebarTab() === "outline" ? "true" : "false"}
                  aria-controls="outline-panel"
                  onClick={() => setSidebarTab("outline")}
                >
                  Outline
                </button>
                <button
                  id="thumbnails-tab"
                  type="button"
                  role="tab"
                  aria-selected={sidebarTab() === "thumbnails" ? "true" : "false"}
                  aria-controls="thumbnails-panel"
                  onClick={() => {
                    setSidebarTab("thumbnails");
                    layoutChanged();
                  }}
                >
                  Thumbnails
                </button>
              </div>
              {sidebarTab() === "outline" ? (
                <div
                  id="outline-panel"
                  role="tabpanel"
                  aria-labelledby="outline-tab"
                  class="outline-panel"
                >
                  {info()?.outline.length ? (
                    <ol class="outline-list">
                      {info()?.outline.map((item) => (
                        <li
                          style={{
                            "padding-inline-start": `${clamp(item.level, 0, 8) * 0.75}rem`,
                          }}
                        >
                          <button
                            type="button"
                            class="outline-item"
                            disabled={item.page === null}
                            title={
                              item.page === null ? "No page destination" : `Page ${item.page + 1}`
                            }
                            aria-current={item.page === currentPage() ? "location" : undefined}
                            onClick={() => {
                              if (item.page !== null) jump(item.page);
                            }}
                          >
                            <span>{item.title}</span>
                            {item.page !== null ? <span class="muted">{item.page + 1}</span> : null}
                          </button>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p class="sidebar-empty">{info() ? "No outline." : "Open a PDF to begin."}</p>
                  )}
                </div>
              ) : (
                <div
                  id="thumbnails-panel"
                  role="tabpanel"
                  aria-labelledby="thumbnails-tab"
                  class="thumbnail-panel"
                >
                  {editor.enabled() ? (
                    <InsertPdf
                      editor={editor}
                      current={currentPage}
                      count={() => info()?.pages || 0}
                    />
                  ) : null}
                  {Array.from({ length: info()?.pages || 0 }, (_unused, index) => (
                    <Thumbnail
                      index={index}
                      root={() => sidebar}
                      current={currentPage}
                      navigate={jump}
                      count={() => info()?.pages || 0}
                      subscribe={subscribe}
                      editor={editor}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {editor.enabled() && info()?.pages ? (
            <AnnotationSidebar editor={editor} current={currentPage} />
          ) : null}
        </aside>

        <main
          class="document-viewport"
          aria-label="Document"
          tabindex={0}
          onScroll={readScroll}
          ref={(element) => {
            viewport = element;
          }}
        >
          {info() ? (
            info()?.pages ? (
              <div class="page-stack">
                {Array.from({ length: info()?.pages || 0 }, (_unused, index) => (
                  <Page
                    index={index}
                    root={() => viewport}
                    preferences={preferences}
                    hit={hit}
                    subscribe={subscribe}
                    onSize={onSize}
                    navigate={jump}
                    editor={editor}
                  />
                ))}
              </div>
            ) : (
              <div class="empty-state">
                <h1>This PDF has no pages</h1>
                <p>Open another document to continue.</p>
              </div>
            )
          ) : (
            <div class="empty-state">
              <h1>PDF Viewer</h1>
              <p>Open a PDF, supply its path, or drop it into the native window.</p>
              <Button
                type="button"
                class="viewer-button"
                disabled={opening()}
                onClick={() => {
                  void open();
                }}
              >
                Open PDF
              </Button>
              <button
                type="button"
                class="text-button"
                onClick={() => {
                  setPathPrompt(true);
                  later(() => pathInput?.focus());
                }}
              >
                Enter a file path
              </button>
            </div>
          )}
        </main>
      </div>

      <footer class="viewer-status">
        <span class="document-title" title={info()?.title || "PDF Viewer"}>
          {editor.state().dirty ? "* " : ""}
          {info()?.title || "PDF Viewer"}
        </span>
        {info()?.encrypted ? <span>Encrypted</span> : null}
        {editor.state().dirty ? <span>Unsaved changes</span> : null}
        {editor.status() ? (
          <span class="editing-save-status" role="status">
            {editor.status()}
          </span>
        ) : null}
        <span class="muted">
          {isMock ? "Development preview: placeholder page images" : "PDF toolkit"}
        </span>
      </footer>
    </div>
  );
}

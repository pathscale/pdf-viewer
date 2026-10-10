import { Button } from "@pathscale/ui";
import { createSignal, onSettled } from "solid-js";
import type { DocumentProperties } from "../api";
import type { Editor } from "../editing";
import { PROPERTY_FIELDS } from "../editing";
import { IconButton } from "./IconButton";

export function AnnotationSidebar(props: { editor: Editor; current: () => number }) {
  const editor = props.editor;
  const items = () => editor.annotations()[props.current()];
  return (
    <section class="annotation-sidebar" aria-label={`Page ${props.current() + 1} annotations`}>
      <h2>Page {props.current() + 1} annotations</h2>
      {items() ? (
        items()?.length ? (
          <ol class="annotation-list">
            {items()?.map((item) => (
              <li>
                <button
                  type="button"
                  class="annotation-item"
                  aria-pressed={
                    editor.selected()?.page === props.current() &&
                    editor.selected()?.index === item.index
                      ? "true"
                      : "false"
                  }
                  disabled={editor.busy()}
                  onClick={() => editor.select(props.current(), item.index)}
                >
                  <strong>{item.subtype}</strong>
                  <span>{item.contents || `Annotation ${item.index + 1}`}</span>
                </button>
                <IconButton
                  glyph="trash"
                  label={`Delete ${item.subtype} annotation ${item.index + 1}`}
                  disabled={editor.busy()}
                  onClick={() => {
                    void editor.remove(props.current(), item.index);
                  }}
                />
              </li>
            ))}
          </ol>
        ) : (
          <p class="sidebar-empty">No annotations on this page.</p>
        )
      ) : (
        <Button
          type="button"
          class="viewer-button"
          disabled={editor.busy()}
          onClick={() => editor.showPage(props.current())}
        >
          Load annotations
        </Button>
      )}
      <p class="editing-hint">Select an annotation, then press Delete to remove it.</p>
    </section>
  );
}

export function InsertPdf(props: { editor: Editor; current: () => number; count: () => number }) {
  const [path, setPath] = createSignal("");
  let position!: HTMLInputElement;
  return (
    <form
      class="insert-pdf"
      onSubmit={(event) => {
        event.preventDefault();
        const source = path().trim();
        const at = Number(position.value) - 1;
        if (!source || !Number.isInteger(at) || at < 0 || at > props.count()) return;
        void props.editor.insert(source, at).then((success) => {
          if (success) setPath("");
        });
      }}
    >
      <label>
        <span>Insert PDF by path</span>
        <input
          class="viewer-input"
          type="text"
          aria-label="PDF path to insert"
          placeholder="Absolute PDF path"
          value={path()}
          required
          disabled={props.editor.busy()}
          onInput={(event) => setPath(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>Before page (last position appends)</span>
        <input
          class="viewer-input"
          type="number"
          min="1"
          max={props.count() + 1}
          value={Math.min(props.current() + 2, props.count() + 1)}
          aria-label="Insert before page"
          required
          disabled={props.editor.busy()}
          ref={(element) => {
            position = element;
          }}
        />
      </label>
      <Button type="submit" class="viewer-button" disabled={props.editor.busy() || !path().trim()}>
        Insert PDF
      </Button>
    </form>
  );
}

export function PropertiesDialog(props: { editor: Editor }) {
  const initial = props.editor.properties();
  const [values, setValues] = createSignal<Record<keyof DocumentProperties, string>>({
    title: initial?.title || "",
    author: initial?.author || "",
    subject: initial?.subject || "",
    keywords: initial?.keywords || "",
  });
  let panel!: HTMLDivElement;

  onSettled(() => {
    const previous = document.activeElement;
    const timer = window.setTimeout(
      () => panel.querySelector<HTMLInputElement>("input")?.focus(),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
    };
  });

  return (
    <div class="properties-backdrop">
      <div
        class="properties-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="properties-heading"
        tabindex={-1}
        ref={(element) => {
          panel = element;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.editor.busy()) {
            event.preventDefault();
            event.stopPropagation();
            props.editor.closeProperties();
          } else if (event.key === "Tab") {
            const controls = panel.querySelectorAll<HTMLElement>(
              "input:not(:disabled), button:not(:disabled)",
            );
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (!first || !last) return;
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 id="properties-heading">Document properties</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void props.editor.applyProperties(values());
          }}
        >
          {PROPERTY_FIELDS.map((item) => (
            <label>
              <span>{item.label}</span>
              <input
                class="viewer-input"
                type="text"
                aria-label={item.label}
                value={values()[item.field]}
                disabled={props.editor.busy()}
                onInput={(event) => {
                  const text = event.currentTarget.value;
                  setValues((previous) => ({ ...previous, [item.field]: text }));
                }}
              />
            </label>
          ))}
          <div class="editing-tools">
            <Button type="submit" class="viewer-button" disabled={props.editor.busy()}>
              Apply properties
            </Button>
            <Button
              type="button"
              class="viewer-button"
              disabled={props.editor.busy()}
              onClick={props.editor.closeProperties}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

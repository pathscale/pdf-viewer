import { Button } from "@pathscale/ui";
import { createSignal } from "solid-js";
import type { AnnotationInput, PageSize, Point } from "../api";
import { isMock } from "../api";
import type { Editor } from "../editing";
import { bounds, displayRect, displayToPdf, noteRect, pdfTransform } from "../pageCoordinates";
import { AnnotationShape } from "./AnnotationShape";

interface Gesture {
  pointer: number;
  input: AnnotationInput;
  start: Point;
  end: Point;
  points: Point[];
  size: PageSize;
  revision: number;
  interaction: number;
  tolerance: number;
}

interface Draft {
  input: AnnotationInput;
  revision: number;
  interaction: number;
}

function simplified(points: Point[], tolerance: number): Point[] {
  const first = points[0];
  if (!first) return [];
  const result: Point[] = [first];
  for (let index = 1; index < points.length - 1; index++) {
    const previous = result[result.length - 1];
    const point = points[index];
    const next = points[index + 1];
    const dx = next[0] - previous[0];
    const dy = next[1] - previous[1];
    const length = Math.hypot(dx, dy);
    const distance = length
      ? Math.abs(dy * point[0] - dx * point[1] + next[0] * previous[1] - next[1] * previous[0]) /
        length
      : Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    const between =
      (point[0] - previous[0]) * (point[0] - next[0]) +
        (point[1] - previous[1]) * (point[1] - next[1]) <=
      0;
    if (distance > tolerance || !between) result.push(point);
  }
  const last = points[points.length - 1];
  if (points.length > 1) result.push(last);
  return result;
}

export function AnnotationOverlay(props: {
  index: number;
  size: () => PageSize;
  ready: () => boolean;
  editor: Editor;
}) {
  const editor = props.editor;
  const [gesture, setGesture] = createSignal<Gesture | null>(null);
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [text, setText] = createSignal("");
  let layer!: HTMLDivElement;
  let contents!: HTMLTextAreaElement;

  function current(value: { revision: number; interaction: number }): boolean {
    return (
      editor.enabled() &&
      value.revision === editor.revision() &&
      value.interaction === editor.interaction()
    );
  }

  function activeDraft(): Draft | null {
    const value = draft();
    return value && current(value) ? value : null;
  }

  function point(event: PointerEvent, size: PageSize): Point | null {
    const rect = layer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return displayToPdf(
      [
        ((event.clientX - rect.left) / rect.width) * size.width,
        ((event.clientY - rect.top) / rect.height) * size.height,
      ],
      size,
    );
  }

  function release(pointer: number): void {
    try {
      if (layer.hasPointerCapture(pointer)) layer.releasePointerCapture(pointer);
    } catch {
      // Capture is optional in the embedded engine.
    }
  }

  function cancel(): void {
    const value = gesture();
    setGesture(null);
    if (value) release(value.pointer);
  }

  function build(value: Gesture): AnnotationInput {
    const input = { ...value.input };
    if (input.kind === "note") return input;
    if (input.kind === "ink") {
      const points = simplified(value.points, value.tolerance);
      input.paths = [points];
      input.rect = bounds(points, (input.width || 2) / 2);
    } else {
      input.rect = bounds([value.start, value.end]);
      if (input.kind === "highlight") {
        const [x0, y0, x1, y1] = input.rect;
        input.quads = [[x0, y1, x1, y1, x0, y0, x1, y0]];
      }
    }
    return input;
  }

  function start(event: PointerEvent): void {
    if (
      !editor.enabled() ||
      editor.busy() ||
      !props.ready() ||
      activeDraft() ||
      gesture() ||
      event.button !== 0 ||
      !event.isPrimary
    )
      return;
    const size = { ...props.size() };
    const position = point(event, size);
    if (!position) return;
    event.preventDefault();
    layer.focus({ preventScroll: true });
    if (editor.tool() === "select") {
      const annotations = editor.annotations()[props.index] || [];
      for (let index = annotations.length - 1; index >= 0; index--) {
        const item = annotations[index];
        const [x0, y0, x1, y1] = item.rect;
        if (
          position[0] >= Math.min(x0, x1) &&
          position[0] <= Math.max(x0, x1) &&
          position[1] >= Math.min(y0, y1) &&
          position[1] <= Math.max(y0, y1)
        ) {
          editor.select(props.index, item.index);
          return;
        }
      }
      editor.clearSelection();
      return;
    }
    editor.clearSelection();
    const kind = editor.tool();
    if (kind === "select") return;
    const input: AnnotationInput = {
      index: props.index,
      kind,
      rect: [position[0], position[1], position[0], position[1]],
      color: [...editor.color()],
      opacity: kind === "highlight" ? editor.opacity() : 1,
      width: 2,
    };
    if (kind === "note") input.rect = noteRect(position, size);
    if (kind === "free_text") input.size = 12;
    const rect = layer.getBoundingClientRect();
    setGesture({
      pointer: event.pointerId,
      input,
      start: position,
      end: position,
      points: [position],
      size,
      revision: editor.revision(),
      interaction: editor.interaction(),
      tolerance:
        (Math.max(size.width / rect.width, size.height / rect.height) * 1.5) / size.user_unit,
    });
    try {
      layer.setPointerCapture(event.pointerId);
    } catch {
      // Pointer cancellation still discards the unfinished gesture.
    }
  }

  function move(event: PointerEvent, final = false): void {
    const value = gesture();
    if (!value || value.pointer !== event.pointerId) return;
    if (!current(value) || !props.ready()) {
      cancel();
      return;
    }
    const position = point(event, value.size);
    if (!position) return;
    event.preventDefault();
    let points = value.points;
    let tolerance = value.tolerance;
    if (value.input.kind === "ink") {
      const last = points[points.length - 1];
      const distance = Math.hypot(position[0] - last[0], position[1] - last[1]);
      if (distance >= tolerance || (final && distance > 0)) {
        if (points.length >= 2048) {
          points = points.filter((_point, index) => index % 2 === 0 || index === points.length - 1);
          tolerance *= 2;
        }
        points = [...points, position];
      }
    }
    setGesture({ ...value, end: position, points, tolerance });
  }

  function finish(event: PointerEvent): void {
    const initial = gesture();
    if (!initial || initial.pointer !== event.pointerId) return;
    move(event, true);
    const value = gesture();
    setGesture(null);
    release(event.pointerId);
    if (!value || !current(value)) return;
    const input = build(value);
    const [x0, y0, x1, y1] = input.rect;
    if (input.kind === "ink") {
      if ((input.paths?.[0]?.length || 0) < 2) return;
    } else if (input.kind !== "note" && (x1 - x0 < 2 || y1 - y0 < 2)) {
      return;
    }
    if (input.kind === "note" || input.kind === "free_text") {
      setText("");
      setDraft({
        input,
        revision: value.revision,
        interaction: value.interaction,
      });
      window.setTimeout(() => {
        if (activeDraft()) contents?.focus();
      }, 0);
    } else {
      void editor.annotate(input);
    }
  }

  const preview = () => {
    const value = gesture();
    if (value && current(value)) return build(value);
    const pending = activeDraft();
    return pending
      ? {
          ...pending.input,
          text: pending.input.kind === "free_text" ? text() : undefined,
          contents: text(),
        }
      : null;
  };

  const selectedRect = () => {
    const selection = editor.selected();
    if (selection?.page !== props.index) return null;
    const item = editor
      .annotations()
      [props.index]?.find((annotation) => annotation.index === selection.index);
    return item ? displayRect(item.rect, props.size()) : null;
  };

  const TOOL_NAMES: Record<string, string> = {
    highlight: "highlight",
    note: "note",
    ink: "drawing",
    free_text: "text box",
    square: "rectangle",
    circle: "ellipse",
  };
  // While a placing tool is active the layer is an operable control, not just a container.
  const placing = () => editor.enabled() && props.ready() && editor.tool() !== "select";

  return (
    <div
      class={{
        "annotation-overlay": true,
        active: editor.enabled() && props.ready(),
        selecting: editor.tool() === "select",
      }}
      role={placing() ? "button" : "group"}
      aria-label={
        placing()
          ? `Place ${TOOL_NAMES[editor.tool()] ?? editor.tool()} on page ${props.index + 1}`
          : `Annotations on page ${props.index + 1}`
      }
      tabindex={editor.enabled() ? 0 : -1}
      ref={(element) => {
        layer = element;
      }}
      onPointerDown={start}
      onPointerMove={(event) => move(event)}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel();
          setDraft(null);
          editor.clearSelection();
          event.preventDefault();
          event.stopPropagation();
          layer.focus();
        }
      }}
    >
      <svg
        class="annotation-preview"
        viewBox={`0 0 ${props.size().width} ${props.size().height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g transform={pdfTransform(props.size())}>
          {isMock
            ? (editor.annotations()[props.index] || []).map((item) =>
                item.preview ? <AnnotationShape input={item.preview} /> : null,
              )
            : null}
          {preview() ? <AnnotationShape input={preview() as AnnotationInput} /> : null}
        </g>
        {selectedRect() ? (
          <rect
            x={selectedRect()?.[0]}
            y={selectedRect()?.[1]}
            width={(selectedRect()?.[2] || 0) - (selectedRect()?.[0] || 0)}
            height={(selectedRect()?.[3] || 0) - (selectedRect()?.[1] || 0)}
            fill="none"
            stroke="#3157b8"
            stroke-width="2"
            stroke-dasharray="5 3"
            vector-effect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      {activeDraft() ? (
        <form
          class="annotation-composer"
          onSubmit={(event) => {
            event.preventDefault();
            const pending = activeDraft();
            if (!pending || !text().trim()) return;
            const input = {
              ...pending.input,
              contents: text(),
              ...(pending.input.kind === "free_text" ? { text: text() } : {}),
            };
            void editor.annotate(input).then((success) => {
              if (success) {
                setDraft(null);
                layer.focus();
              }
            });
          }}
        >
          <label>
            <span>
              {activeDraft()?.input.kind === "note" ? "Note contents" : "Text box contents"}
            </span>
            <textarea
              class="viewer-input"
              rows="4"
              maxlength={16384}
              required
              value={text()}
              disabled={editor.busy()}
              onInput={(event) => setText(event.currentTarget.value)}
              ref={(element) => {
                contents = element;
              }}
            />
          </label>
          <div class="editing-tools">
            <Button type="submit" class="viewer-button" disabled={editor.busy() || !text().trim()}>
              Add annotation
            </Button>
            <Button
              type="button"
              class="viewer-button"
              disabled={editor.busy()}
              onClick={() => {
                setDraft(null);
                layer.focus();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}


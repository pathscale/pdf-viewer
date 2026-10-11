import { Button } from "@pathscale/ui";
import { createEffect, createSignal } from "solid-js";
import type { AnnotationInput, PageSize, Point, TextLine } from "../api";
import { isMock } from "../api";
import type { Editor } from "../editing";
import {
  bounds,
  displayRect,
  displayToPdf,
  noteRect,
  pdfToDisplay,
  pdfTransform,
} from "../pageCoordinates";
import type { GlyphPosition } from "../textSelection";
import {
  glyphAt,
  lineAt,
  nearestGlyph,
  selectedText,
  textFragments,
  wordAt,
} from "../textSelection";
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
  text: { lines: TextLine[]; anchor: GlyphPosition } | null;
}

interface Draft {
  input: AnnotationInput;
  revision: number;
  interaction: number;
}

// Local text selection only. It is never submitted as an annotation.
interface TextRange {
  lines: TextLine[];
  anchor: GlyphPosition;
  endpoint: GlyphPosition;
}

interface TextDrag {
  pointer: number;
  anchor: GlyphPosition;
  lines: TextLine[];
}

// The overlay that made the most recent text selection answers Cmd/Ctrl+C anywhere in the
// window: focus does not reliably stay on the layer after a double or triple click.
let copySource: (() => string | null) | null = null;
let copyListening = false;

function listenForCopy(): void {
  if (copyListening || typeof document === "undefined") return;
  copyListening = true;
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "c") return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }
    const text = copySource?.();
    if (!text) return;
    event.preventDefault();
    void navigator.clipboard.writeText(text).catch(() => {});
  });
}

// A press counts as a repeat click within this time and distance of the previous one.
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 4;

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
  lines: () => TextLine[] | null;
  ready: () => boolean;
  editor: Editor;
}) {
  const editor = props.editor;
  const [gesture, setGesture] = createSignal<Gesture | null>(null);
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [text, setText] = createSignal("");
  const [textSelection, setTextSelection] = createSignal<TextRange | null>(null);
  const [textDrag, setTextDrag] = createSignal<TextDrag | null>(null);
  const [textCursor, setTextCursor] = createSignal(false);
  let layer!: HTMLDivElement;
  let contents!: HTMLTextAreaElement;
  let lastPress: { time: number; x: number; y: number; count: number } | null = null;
  const copyText = (): string | null => {
    const range = textSelection();
    if (!range || (editor.enabled() && editor.tool() !== "select")) return null;
    return selectedText(range.lines, range.anchor, range.endpoint);
  };
  listenForCopy();
  let seenPage = -1;
  let seenTool = "";
  let seenLines: TextLine[] | null = null;
  let seenLinesSet = false;

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

  function displayPoint(event: PointerEvent, size: PageSize): Point | null {
    const rect = layer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return [
      ((event.clientX - rect.left) / rect.width) * size.width,
      ((event.clientY - rect.top) / rect.height) * size.height,
    ];
  }

  function point(event: PointerEvent, size: PageSize): Point | null {
    const display = displayPoint(event, size);
    if (!display) return null;
    return displayToPdf(display, size);
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
    const drag = textDrag();
    setTextDrag(null);
    if (drag) release(drag.pointer);
  }

  function beginText(event: PointerEvent): void {
    const lines = props.lines();
    if (!lines?.length) {
      setTextSelection(null);
      return;
    }
    const display = displayPoint(event, props.size());
    const anchor = display ? glyphAt(lines, display) : null;
    if (!anchor) {
      setTextSelection(null);
      return;
    }
    event.preventDefault();
    copySource = copyText;
    // Count clicks here: some engines always report `detail` as 1.
    const now = performance.now();
    const near =
      lastPress !== null &&
      now - lastPress.time <= MULTI_CLICK_MS &&
      Math.abs(event.clientX - lastPress.x) <= MULTI_CLICK_PX &&
      Math.abs(event.clientY - lastPress.y) <= MULTI_CLICK_PX;
    const clicks = Math.max(event.detail, near && lastPress ? lastPress.count + 1 : 1);
    lastPress = { time: now, x: event.clientX, y: event.clientY, count: clicks };
    if (clicks >= 2) {
      const span = clicks >= 3 ? lineAt(lines, anchor) : wordAt(lines, anchor);
      setTextSelection({
        lines,
        anchor: span?.anchor ?? anchor,
        endpoint: span?.endpoint ?? anchor,
      });
      setTextCursor(true);
      // Hold the pointer like a drag does, so the release keeps focus here for Cmd/Ctrl+C.
      try {
        layer.setPointerCapture(event.pointerId);
      } catch {
        // Capture is best effort.
      }
      layer.focus({ preventScroll: true });
      return;
    }
    setTextSelection({ lines, anchor, endpoint: anchor });
    setTextDrag({ pointer: event.pointerId, anchor, lines });
    setTextCursor(true);
    try {
      layer.setPointerCapture(event.pointerId);
    } catch {
      // Pointer cancellation still discards the unfinished gesture.
    }
    layer.focus({ preventScroll: true });
  }

  function moveText(event: PointerEvent): void {
    const drag = textDrag();
    if (!drag || drag.pointer !== event.pointerId) return;
    const display = displayPoint(event, props.size());
    if (!display) return;
    const endpoint = nearestGlyph(drag.lines, display) ?? drag.anchor;
    event.preventDefault();
    setTextSelection({ lines: drag.lines, anchor: drag.anchor, endpoint });
  }

  function finishText(event: PointerEvent): boolean {
    const drag = textDrag();
    if (!drag || drag.pointer !== event.pointerId) return false;
    moveText(event);
    setTextDrag(null);
    release(event.pointerId);
    hover(event);
    return true;
  }

  function hover(event: PointerEvent): void {
    if (textDrag()) {
      if (!textCursor()) setTextCursor(true);
      return;
    }
    if (editor.enabled() && editor.tool() !== "select") {
      if (textCursor()) setTextCursor(false);
      return;
    }
    const lines = props.lines();
    const display = lines?.length ? displayPoint(event, props.size()) : null;
    const next = !!display && !!lines && glyphAt(lines, display) !== null;
    if (next !== textCursor()) setTextCursor(next);
  }

  function selectionFragments() {
    const range = textSelection();
    if (!range || (editor.enabled() && editor.tool() !== "select")) return [];
    const { lines, anchor, endpoint } = range;
    if (!lines[anchor.line] || !lines[endpoint.line]) return [];
    // PDF-space quads, drawn inside the pdfTransform group like the highlight preview.
    return textFragments(lines, anchor, endpoint, props.size()).quads;
  }

  // Solid 2: the compute half tracks the inputs; the effect half clears a stale selection.
  createEffect(
    () => ({
      page: props.index,
      tool: editor.tool(),
      allow: !editor.enabled() || editor.tool() === "select",
      lines: props.lines(),
    }),
    ({ page, tool, allow, lines }) => {
      const changed =
        seenLinesSet && (page !== seenPage || tool !== seenTool || !allow || lines !== seenLines);
      seenPage = page;
      seenTool = tool;
      seenLines = lines;
      seenLinesSet = true;
      if (!changed) return;
      setTextSelection(null);
      setTextCursor(false);
      const drag = textDrag();
      setTextDrag(null);
      if (drag) release(drag.pointer);
    },
  );

  function build(value: Gesture): AnnotationInput {
    const input = { ...value.input };
    if (input.kind === "note") return input;
    if (input.kind === "highlight" && value.text) {
      const { lines, anchor } = value.text;
      // Text lines are in display space; the gesture is in PDF space.
      const endpoint = nearestGlyph(lines, pdfToDisplay(value.end, value.size)) ?? anchor;
      return { ...input, ...textFragments(lines, anchor, endpoint, value.size) };
    }
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
    if (event.button !== 0 || !event.isPrimary) return;
    if (!editor.enabled()) {
      if (textDrag()) return;
      beginText(event);
      return;
    }
    if (editor.busy() || !props.ready() || activeDraft() || gesture() || textDrag()) return;
    const lines = props.lines();
    if (editor.tool() === "highlight" && lines === null) return;
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
          setTextSelection(null);
          return;
        }
      }
      editor.clearSelection();
      beginText(event);
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
    const anchor =
      kind === "highlight" && lines ? glyphAt(lines, pdfToDisplay(position, size)) : null;
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
      text: anchor && lines ? { lines, anchor } : null,
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
    if (finishText(event)) return;
    const initial = gesture();
    if (!initial || initial.pointer !== event.pointerId) return;
    move(event, true);
    const value = gesture();
    setGesture(null);
    release(event.pointerId);
    if (!value || !current(value)) return;
    const input = build(value);
    const [x0, y0, x1, y1] = input.rect;
    if (value.text) {
      if (
        !input.quads?.length ||
        !input.rect.every(Number.isFinite) ||
        x0 >= x1 ||
        y0 >= y1 ||
        Math.hypot(value.end[0] - value.start[0], value.end[1] - value.start[1]) < value.tolerance
      )
        return;
    } else if (input.kind === "ink") {
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
    if (value && current(value)) {
      const input = build(value);
      return input.kind === "highlight"
        ? { ...input, opacity: Math.min(input.opacity, 0.4) }
        : input;
    }
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
        "text-selectable": !editor.enabled() && props.ready() && (props.lines()?.length || 0) > 0,
        "text-cursor": textCursor(),
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
      onPointerMove={(event) => {
        move(event);
        moveText(event);
        hover(event);
      }}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onPointerLeave={() => {
        if (!textDrag()) setTextCursor(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel();
          setTextSelection(null);
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
          <g
            class="text-selection"
            fill="rgb(66,133,244)"
            opacity="0.35"
            style={{ "mix-blend-mode": "multiply" }}
          >
            {selectionFragments().map((quad) => (
              <polygon
                points={`${quad[0]},${quad[1]} ${quad[2]},${quad[3]} ${quad[6]},${quad[7]} ${quad[4]},${quad[5]}`}
              />
            ))}
          </g>
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

import { createSignal, onSettled } from "solid-js";
import type { PageSize } from "../api";
import { api, isMock } from "../api";
import type { Editor } from "../editing";
import { pdfTransform } from "../pageCoordinates";
import { message, observeNear, schedule } from "../runtime";
import { AnnotationShape } from "./AnnotationShape";
import { IconButton } from "./IconButton";

interface ThumbnailProps {
  index: number;
  root: () => HTMLElement;
  current: () => number;
  navigate: (index: number) => void;
  count: () => number;
  subscribe: (handler: () => void) => () => void;
  editor: Editor;
}

export function Thumbnail(props: ThumbnailProps) {
  const [png, setPng] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [size, setSize] = createSignal<PageSize>({
    width: 612,
    height: 792,
    rotate: 0,
    origin: [0, 0],
    user_unit: 1,
  });
  let button!: HTMLButtonElement;

  onSettled(() => {
    let disposed = false;
    let near = false;
    let revision = 0;
    let contentRevision = props.editor.revision();

    function load(): void {
      if (!near || disposed) return;
      const ticket = ++revision;
      const content = contentRevision;
      const valid = () =>
        !disposed && near && ticket === revision && content === props.editor.revision();
      setError("");
      void schedule(async () => {
        const dimensions = await api.pageSize(props.index);
        const image = await api.thumbnail(props.index);
        return { dimensions, image };
      }, valid)
        .then((reply) => {
          if (!valid()) return;
          setSize({ ...reply.dimensions, rotate: reply.dimensions.rotate ?? 0 });
          setPng(reply.image.png);
          if (isMock && !props.editor.annotations()[props.index]) {
            void props.editor.loadAnnotations(props.index, valid).catch((reason) => {
              if (valid()) setError(message(reason));
            });
          }
        })
        .catch((reason) => {
          if (valid()) setError(message(reason));
        });
    }

    const observer = observeNear(button, props.root(), (visible) => {
      near = visible;
      revision++;
      if (!visible) {
        setPng(null);
        return;
      }
      load();
    });
    const unsubscribe = props.subscribe(() => {
      const next = props.editor.revision();
      if (next !== contentRevision) {
        contentRevision = next;
        revision++;
        setPng(null);
        if (near) load();
      }
      observer.check();
    });
    return () => {
      disposed = true;
      revision++;
      unsubscribe();
      observer.dispose();
    };
  });

  const disabled = () => props.editor.busy() || !props.editor.available();

  return (
    <div
      class="thumbnail-entry"
      draggable={props.editor.enabled() && !disabled() ? "true" : "false"}
      onDragStart={(event) => {
        if (!props.editor.enabled() || disabled()) {
          event.preventDefault();
          return;
        }
        props.editor.startDrag(props.index);
        event.dataTransfer?.setData("text/plain", String(props.index));
      }}
      onDragEnd={props.editor.endDrag}
      onDragOver={(event) => {
        if (props.editor.enabled() && props.editor.dragging() !== null && !disabled()) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        if (!props.editor.enabled() || disabled()) return;
        const from = props.editor.dragging();
        if (from === null) return;
        event.preventDefault();
        props.editor.endDrag();
        void props.editor.move(from, props.index);
      }}
    >
      <button
        type="button"
        class="thumbnail-button"
        aria-label={`Go to page ${props.index + 1}`}
        aria-current={props.current() === props.index ? "page" : undefined}
        title={error() || `Go to page ${props.index + 1}`}
        onClick={() => props.navigate(props.index)}
        ref={(element) => {
          button = element;
        }}
      >
        <span
          class="thumbnail-paper"
          style={{ "aspect-ratio": `${size().width} / ${size().height}` }}
        >
          {png() ? (
            <img src={`data:image/png;base64,${png()}`} alt="" draggable={false} />
          ) : (
            <span class="muted">{error() ? "Unavailable" : props.index + 1}</span>
          )}
          {isMock ? (
            <svg
              class="thumbnail-annotations"
              viewBox={`0 0 ${size().width} ${size().height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
            >
              <g transform={pdfTransform(size())}>
                {(props.editor.annotations()[props.index] || []).map((item) =>
                  item.preview ? <AnnotationShape input={item.preview} /> : null,
                )}
              </g>
            </svg>
          ) : null}
        </span>
        <span>{props.index + 1}</span>
      </button>
      {props.editor.enabled() ? (
        <div class="thumbnail-actions" role="group" aria-label={`Organize page ${props.index + 1}`}>
          <IconButton
            glyph="move-up"
            label={`Move page ${props.index + 1} earlier`}
            disabled={disabled() || props.index === 0}
            onClick={() => {
              void props.editor.move(props.index, props.index - 1);
            }}
          />
          <IconButton
            glyph="move-down"
            label={`Move page ${props.index + 1} later`}
            disabled={disabled() || props.index >= props.count() - 1}
            onClick={() => {
              void props.editor.move(props.index, props.index + 1);
            }}
          />
          <IconButton
            glyph="rotate-left"
            label={`Rotate page ${props.index + 1} left`}
            disabled={disabled()}
            onClick={() => {
              void props.editor.rotate(props.index, -1);
            }}
          />
          <IconButton
            glyph="rotate-right"
            label={`Rotate page ${props.index + 1} right`}
            disabled={disabled()}
            onClick={() => {
              void props.editor.rotate(props.index, 1);
            }}
          />
          <IconButton
            glyph="trash"
            label={`Delete page ${props.index + 1}`}
            disabled={disabled() || props.count() <= 1}
            onClick={() => {
              void props.editor.deletePage(props.index);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

import { createSignal, onSettled } from "solid-js";
import { api } from "../api";
import { message, observeNear, schedule } from "../runtime";

interface ThumbnailProps {
  index: number;
  root: () => HTMLElement;
  current: () => number;
  navigate: (index: number) => void;
}

export function Thumbnail(props: ThumbnailProps) {
  const [png, setPng] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  let button!: HTMLButtonElement;

  onSettled(() => {
    let disposed = false;
    let revision = 0;
    const observer = observeNear(button, props.root(), (visible) => {
      const ticket = ++revision;
      if (!visible) {
        setPng(null);
        return;
      }
      const valid = () => !disposed && ticket === revision;
      setError("");
      void schedule(() => api.thumbnail(props.index), valid)
        .then((image) => {
          if (valid()) setPng(image.png);
        })
        .catch((reason) => {
          if (valid()) setError(message(reason));
        });
    });
    return () => {
      disposed = true;
      revision++;
      observer.dispose();
    };
  });

  return (
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
      <span class="thumbnail-paper">
        {png() ? (
          <img src={`data:image/png;base64,${png()}`} alt="" draggable={false} />
        ) : (
          <span class="muted">{error() ? "Unavailable" : props.index + 1}</span>
        )}
      </span>
      <span>{props.index + 1}</span>
    </button>
  );
}


import { Button } from "@pathscale/ui";
import { createSignal, onSettled } from "solid-js";

interface PasswordDialogProps {
  fileName: string;
  busy: boolean;
  error: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordDialog(props: PasswordDialogProps) {
  const [password, setPassword] = createSignal("");
  let panel!: HTMLDivElement;
  let passwordInput!: HTMLInputElement;

  onSettled(() => {
    const previous = document.activeElement;
    const timer = window.setTimeout(() => passwordInput?.focus(), 0);
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
        aria-labelledby="password-prompt-heading"
        tabindex={-1}
        ref={(element) => {
          panel = element;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) {
            event.preventDefault();
            event.stopPropagation();
            props.onCancel();
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
        <h2 id="password-prompt-heading">Password required</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit(password());
          }}
        >
          <label>
            <span>Password</span>
            <input
              class="viewer-input"
              type="password"
              aria-label={`Password for ${props.fileName}`}
              autocomplete="current-password"
              value={password()}
              disabled={props.busy}
              ref={(element) => {
                passwordInput = element;
              }}
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          {props.error ? (
            <p class="error-banner" role="alert">
              {props.error}
            </p>
          ) : null}
          <div class="editing-tools">
            <Button
              type="submit"
              class="viewer-button"
              disabled={props.busy}
            >
              Open encrypted PDF
            </Button>
            <Button
              type="button"
              class="viewer-button"
              aria-label="Cancel password entry"
              disabled={props.busy}
              onClick={props.onCancel}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

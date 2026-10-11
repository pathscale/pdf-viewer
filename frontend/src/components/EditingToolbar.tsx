import { Button } from "@pathscale/ui";
import { createSignal, onSettled } from "solid-js";
import type { Color } from "../api";
import type { Editor, EditTool } from "../editing";
import { IconButton } from "./IconButton";

const TOOLS: { value: EditTool; label: string }[] = [
  { value: "select", label: "Select" },
  { value: "highlight", label: "Highlight" },
  { value: "note", label: "Note" },
  { value: "ink", label: "Draw" },
  { value: "free_text", label: "Text box" },
  { value: "square", label: "Rectangle" },
  { value: "circle", label: "Ellipse" },
];

const COLORS: { name: string; css: string; value: Color }[] = [
  { name: "Yellow", css: "#ffd900", value: [1, 0.85, 0] },
  { name: "Green", css: "#40bf60", value: [0.25, 0.75, 0.375] },
  { name: "Blue", css: "#4080ff", value: [0.25, 0.5, 1] },
  { name: "Pink", css: "#ff80bf", value: [1, 0.5, 0.75] },
  { name: "Red", css: "#e63333", value: [0.9, 0.2, 0.2] },
  { name: "Black", css: "#000000", value: [0, 0, 0] },
];

function encryptedPath(path: string | null): string {
  const source = path || "document.pdf";
  const separator = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
  const directory = source.slice(0, separator + 1);
  const fileName = source.slice(separator + 1) || "document.pdf";
  const stem = fileName.replace(/\.pdf$/i, "") || "document";
  return `${directory}${stem}-encrypted.pdf`;
}

function saveErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Could not save the encrypted PDF.";
}

export function EditingToolbar(props: { editor: Editor }) {
  const editor = props.editor;
  const [encryptedSaveOpen, setEncryptedSaveOpen] = createSignal(false);
  return (
    <>
      <div class="editing-toolbar" role="toolbar" aria-label="PDF editing">
        <div class="editing-tools" role="group" aria-label="Annotation tool">
          {TOOLS.map((item) => (
            <IconButton
              glyph={item.value}
              label={item.label}
              text={item.label}
              pressed={editor.tool() === item.value}
              disabled={editor.busy()}
              onClick={() => editor.chooseTool(item.value)}
            />
          ))}
        </div>
        <div class="editing-colors" role="group" aria-label="Annotation colour">
          {COLORS.map((item) => (
            <button
              type="button"
              class="colour-swatch"
              style={{ "background-color": item.css }}
              aria-label={item.name}
              title={item.name}
              aria-pressed={
                editor.color().every((value, index) => value === item.value[index])
                  ? "true"
                  : "false"
              }
              disabled={editor.busy()}
              onClick={() => editor.setColor([...item.value] as Color)}
            />
          ))}
        </div>
        {editor.tool() === "highlight" ? (
          <label class="editing-opacity">
            <span>Opacity</span>
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={editor.opacity()}
              aria-label="Highlight opacity"
              disabled={editor.busy()}
              onInput={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isFinite(value)) editor.setOpacity(Math.min(1, Math.max(0.1, value)));
              }}
            />
            <output>{Math.round(editor.opacity() * 100)}%</output>
          </label>
        ) : null}
        <div class="editing-tools" role="group" aria-label="Edit history and saving">
          <IconButton
            glyph="undo"
            label="Undo (Cmd+Z)"
            disabled={editor.busy() || !editor.state().can_undo}
            onClick={() => {
              void editor.undo();
            }}
          />
          <IconButton
            glyph="redo"
            label="Redo (Cmd+Shift+Z)"
            disabled={editor.busy() || !editor.state().can_redo}
            onClick={() => {
              void editor.redo();
            }}
          />
          <Button
            type="button"
            class="viewer-button"
            disabled={editor.busy()}
            onClick={() => {
              void editor.save("in_place");
            }}
          >
            Save
          </Button>
          <Button
            type="button"
            class="viewer-button"
            disabled={editor.busy()}
            onClick={() => {
              void editor.save("copy");
            }}
          >
            Save copy
          </Button>
          <Button
            type="button"
            class="viewer-button"
            aria-label="Save encrypted copy"
            disabled={editor.busy() || !editor.encryptedSaveAvailable()}
            onClick={() => setEncryptedSaveOpen(true)}
          >
            Save encrypted copy
          </Button>
        </div>
        {editor.busy() ? <span role="status">Applying edit...</span> : null}
      </div>
      {encryptedSaveOpen() ? (
        <EncryptedSaveDialog
          editor={editor}
          onClose={() => setEncryptedSaveOpen(false)}
        />
      ) : null}
    </>
  );
}

function EncryptedSaveDialog(props: { editor: Editor; onClose: () => void }) {
  const editor = props.editor;
  const [path, setPath] = createSignal(encryptedPath(editor.state().path));
  const [password, setPassword] = createSignal("");
  const [confirmation, setConfirmation] = createSignal("");
  const [understood, setUnderstood] = createSignal(false);
  const [saveError, setSaveError] = createSignal("");
  let panel!: HTMLDivElement;
  let passwordInput!: HTMLInputElement;

  const canSave = () =>
    !!path().trim() && !!password() && password() === confirmation() && understood();

  onSettled(() => {
    const previous = document.activeElement;
    const timer = window.setTimeout(() => passwordInput?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
    };
  });

  async function submit(): Promise<void> {
    if (!canSave() || editor.busy()) return;
    setSaveError("");
    try {
      const success = await editor.saveEncryptedCopy(path().trim(), password());
      if (success) {
        props.onClose();
      } else {
        setSaveError("Could not save the encrypted PDF.");
      }
    } catch (error) {
      setSaveError(saveErrorText(error));
    }
  }

  return (
    <div class="properties-backdrop">
      <div
        class="properties-dialog encrypted-save-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="encrypted-save-heading"
        tabindex={-1}
        ref={(element) => {
          panel = element;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !editor.busy()) {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
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
        <h2 id="encrypted-save-heading">Save encrypted copy</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label class="encrypted-save-field">
            <span>Encrypted PDF path</span>
            <input
              class="viewer-input"
              type="text"
              aria-label="Encrypted PDF path"
              value={path()}
              required
              disabled={editor.busy()}
              onInput={(event) => setPath(event.currentTarget.value)}
            />
          </label>
          <label class="encrypted-save-field">
            <span>Encryption password</span>
            <input
              class="viewer-input"
              type="password"
              aria-label="Encryption password"
              autocomplete="new-password"
              value={password()}
              required
              disabled={editor.busy()}
              ref={(element) => {
                passwordInput = element;
              }}
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          <label class="encrypted-save-field">
            <span>Confirm encryption password</span>
            <input
              class="viewer-input"
              type="password"
              aria-label="Confirm encryption password"
              autocomplete="new-password"
              value={confirmation()}
              required
              disabled={editor.busy()}
              onInput={(event) => setConfirmation(event.currentTarget.value)}
            />
          </label>
          <p class="error-banner encrypted-save-warning" role="alert">
            Only this viewer and chuzz can open the encrypted file. Acrobat, Preview, web browsers
            and other PDF apps will not open it.
          </p>
          <label class="encrypted-save-confirmation">
            <input
              type="checkbox"
              aria-label="I understand"
              checked={understood()}
              disabled={editor.busy()}
              onChange={(event) => setUnderstood(event.currentTarget.checked)}
            />
            <span>I understand</span>
          </label>
          {saveError() ? (
            <p class="error-banner encrypted-save-error" role="alert">
              {saveError()}
            </p>
          ) : null}
          <div class="editing-tools encrypted-save-actions">
            <Button
              type="submit"
              class="viewer-button"
              aria-label="Save encrypted PDF"
              disabled={editor.busy() || !canSave()}
            >
              Save encrypted PDF
            </Button>
            <Button
              type="button"
              class="viewer-button"
              aria-label="Cancel encrypted save"
              disabled={editor.busy()}
              onClick={props.onClose}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

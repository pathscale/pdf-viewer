import { Button } from "@pathscale/ui";
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

export function EditingToolbar(props: { editor: Editor }) {
  const editor = props.editor;
  return (
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
              editor.color().every((value, index) => value === item.value[index]) ? "true" : "false"
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
      </div>
      {editor.busy() ? <span role="status">Applying edit...</span> : null}
    </div>
  );
}

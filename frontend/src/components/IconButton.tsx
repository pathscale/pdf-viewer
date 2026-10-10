import { Button } from "@pathscale/ui";

/**
 * Icons drawn inline as SVG paths, as chuzz does: no icon font, no icon-set
 * package and no mask support needed in the engine. Plain characters stay for
 * the few the bundled text font has (minus, plus, multiplication sign).
 */
const PATHS: Record<string, string> = {
  menu: "M3 6h18M3 12h18M3 18h18",
  "open-path": "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  "fit-width": "M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4",
  edit: "M4 20l4-1L20 7l-3-3L5 16l-1 4M14 7l3 3",
  select: "M5 3v17l5-5 4 7 3-2-4-7h7L5 3",
  highlight: "M4 20h16M7 14l7-10 5 4-7 10H7v-4M11 8l5 4",
  note: "M4 4h16v12l-5 5H4V4M15 21v-5h5M8 8h8M8 12h5",
  ink: "M3 17c3-11 5-11 5-3s3 8 5-1 4-9 5-3 1 6 3 3",
  free_text: "M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3",
  square: "M4 4h16v16H4V4",
  circle: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18",
  undo: "M8 5l-5 5 5 5M3 10h11a6 6 0 0 1 0 12",
  redo: "M16 5l5 5-5 5M21 10H10a6 6 0 0 0 0 12",
  "rotate-left": "M7 3L3 7l4 4M3 7h9a8 8 0 1 1-8 8",
  "rotate-right": "M17 3l4 4-4 4M21 7h-9a8 8 0 1 0 8 8",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  properties: "M5 3h10l4 4v14H5V3M15 3v5h4M9 12h6M9 16h6",
  "move-up": "M12 20V4M5 11l7-7 7 7",
  "move-down": "M12 4v16M5 13l7 7 7-7",
};

interface IconButtonProps {
  label: string;
  glyph: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  text?: string;
}

export function IconButton(props: IconButtonProps) {
  const path = () => PATHS[props.glyph];
  return (
    <Button
      type="button"
      class={props.text ? "viewer-button" : "viewer-icon-button"}
      title={props.label}
      aria-label={props.label}
      aria-pressed={"pressed" in props ? (props.pressed ? "true" : "false") : undefined}
      disabled={"disabled" in props ? props.disabled : false}
      onClick={() => props.onClick()}
    >
      {path() ? (
        <svg
          viewBox="0 0 24 24"
          width="1em"
          height="1em"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d={path()} />
        </svg>
      ) : (
        <span aria-hidden="true">{props.glyph}</span>
      )}
      {props.text ? <span>{props.text}</span> : null}
    </Button>
  );
}

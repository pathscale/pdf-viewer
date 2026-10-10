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
};

interface IconButtonProps {
  label: string;
  glyph: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}

export function IconButton(props: IconButtonProps) {
  const path = () => PATHS[props.glyph];
  return (
    <Button
      type="button"
      class="viewer-icon-button"
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
    </Button>
  );
}

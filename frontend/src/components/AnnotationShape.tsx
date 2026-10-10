import type { AnnotationInput } from "../api";

function lines(text: string, width: number, size: number): string[] {
  const limit = Math.max(1, Math.floor(width / (size * 0.6)));
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    let remaining = paragraph;
    while (remaining.length > limit) {
      const space = remaining.lastIndexOf(" ", limit);
      const end = space > 0 ? space : limit;
      result.push(remaining.slice(0, end));
      remaining = remaining.slice(end).trimStart();
    }
    result.push(remaining);
  }
  return result;
}

export function AnnotationShape(props: { input: AnnotationInput }) {
  const input = props.input;
  const [x0, y0, x1, y1] = input.rect;
  const width = x1 - x0;
  const height = y1 - y0;
  const colour = `rgb(${input.color.map((value) => Math.round(value * 255)).join(",")})`;
  const stroke = input.width || 2;

  return (
    <g
      opacity={input.opacity}
      fill={colour}
      stroke={colour}
      style={{ "mix-blend-mode": input.kind === "highlight" ? "multiply" : "normal" }}
    >
      {input.kind === "highlight" ? (
        input.quads?.length ? (
          input.quads.map((quad) => (
            <polygon
              points={`${quad[0]},${quad[1]} ${quad[2]},${quad[3]} ${quad[6]},${quad[7]} ${quad[4]},${quad[5]}`}
              stroke="none"
            />
          ))
        ) : (
          <rect x={x0} y={y0} width={width} height={height} stroke="none" />
        )
      ) : input.kind === "ink" ? (
        (input.paths || []).map((path) => (
          <polyline
            points={path.map(([x, y]) => `${x},${y}`).join(" ")}
            fill="none"
            stroke-width={stroke}
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        ))
      ) : input.kind === "square" ? (
        <rect x={x0} y={y0} width={width} height={height} fill="none" stroke-width={stroke} />
      ) : input.kind === "circle" ? (
        <ellipse
          cx={(x0 + x1) / 2}
          cy={(y0 + y1) / 2}
          rx={width / 2}
          ry={height / 2}
          fill="none"
          stroke-width={stroke}
        />
      ) : input.kind === "note" ? (
        <g>
          <rect x={x0} y={y1 - 20} width="20" height="20" stroke-width="1" />
          <path
            d={`M${x0 + 4} ${y1 - 6}h12M${x0 + 4} ${y1 - 10}h12M${x0 + 4} ${y1 - 14}h8`}
            fill="none"
            stroke="#182230"
            stroke-width="1"
          />
        </g>
      ) : (
        <g transform={`translate(${x0} ${y1}) scale(1 -1)`} stroke="none">
          {lines(input.text || "", width, input.size || 12)
            .slice(0, Math.max(1, Math.floor(height / ((input.size || 12) * 1.2))))
            .map((line, index) => (
              <text
                x="0"
                y={(input.size || 12) * (1 + index * 1.2)}
                font-size={String(input.size || 12)}
                font-family="Inter"
              >
                {line}
              </text>
            ))}
        </g>
      )}
    </g>
  );
}

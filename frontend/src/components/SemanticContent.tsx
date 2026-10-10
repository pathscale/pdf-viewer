import { createSignal, onSettled } from "solid-js";
import { api } from "../api";
import type {
  LinkTarget,
  SemanticBlock,
  SemanticImageRef,
  SemanticPage,
  SemanticSpan,
} from "../api";
import { clamp } from "../preferences";
import { message, observeNear, schedule } from "../runtime";

interface ContentProps {
  page: SemanticPage;
  root: () => HTMLElement;
  navigate: (index: number) => void;
}

function targetPage(target: LinkTarget): number | null {
  const index = target.index ?? target.page;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : null;
}

function safeUri(target: LinkTarget): string | null {
  if (typeof target.uri !== "string") return null;
  try {
    const url = new URL(target.uri);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function SemanticAnchor(props: {
  target: LinkTarget;
  text: string;
  navigate: (index: number) => void;
}) {
  const index = targetPage(props.target);
  const uri = safeUri(props.target);
  if (index !== null) {
    return (
      <a
        href={`#page-${index + 1}`}
        onClick={(event) => {
          event.preventDefault();
          props.navigate(index);
        }}
      >
        {props.text}
      </a>
    );
  }
  return uri ? (
    <a href={uri} target="_blank" rel="noopener noreferrer">
      {props.text}
    </a>
  ) : (
    <span>{props.text}</span>
  );
}

function SpanContent(props: {
  span: SemanticSpan;
  baseSize: number;
  page: SemanticPage;
  navigate: (index: number) => void;
}) {
  const part = props.span;
  const link =
    typeof part.link === "number" && Number.isInteger(part.link)
      ? props.page.links[part.link]
      : undefined;
  const scale =
    Number.isFinite(part.size) && part.size > 0
      ? clamp(part.size / props.baseSize, 0.75, 2)
      : 1;

  return (
    <span
      class={{
        "semantic-bold": part.bold ?? part.style?.bold ?? false,
        "semantic-italic": part.italic ?? part.style?.italic ?? false,
        "semantic-monospace": part.monospace ?? part.style?.monospace ?? false,
      }}
      style={{ "font-size": `${scale}em` }}
    >
      {link ? (
        <SemanticAnchor target={link.target} text={part.text} navigate={props.navigate} />
      ) : (
        part.text
      )}
    </span>
  );
}

function BlockContent(props: {
  block: SemanticBlock;
  page: SemanticPage;
  navigate: (index: number) => void;
}) {
  const sizes = props.block.spans
    .map((span) => span.size)
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((a, b) => a - b);
  const baseSize = sizes[Math.floor(sizes.length / 2)] || 12;
  const content = () =>
    props.block.spans.map((span) => (
      <SpanContent
        span={span}
        baseSize={baseSize}
        page={props.page}
        navigate={props.navigate}
      />
    ));
  const kind = props.block.kind;
  const level =
    typeof kind === "object"
      ? kind.heading
      : kind === "heading"
        ? (props.block.level ?? 1)
        : /^h[1-3]$/.test(kind)
          ? Number(kind.slice(1))
          : 0;

  if (level === 1) return <h1>{content()}</h1>;
  if (level === 2) return <h2>{content()}</h2>;
  if (level > 0) return <h3>{content()}</h3>;
  if (kind === "list_item" || kind === "list-item") return <li>{content()}</li>;
  if (kind === "caption") return <p class="semantic-caption">{content()}</p>;
  return <p>{content()}</p>;
}

function SemanticImage(props: {
  image: SemanticImageRef;
  root: () => HTMLElement;
}) {
  const [source, setSource] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  let figure!: HTMLElement;

  onSettled(() => {
    let disposed = false;
    let revision = 0;
    const observer = observeNear(figure, props.root(), (visible) => {
      const ticket = ++revision;
      if (!visible) {
        setSource(null);
        return;
      }
      const object = props.image.object;
      if (!object) return;
      const valid = () => !disposed && ticket === revision;
      setError("");
      void schedule(() => api.pageImage(object), valid)
        .then((image) => {
          if (!valid()) return;
          if (image.mime !== "image/png" && image.mime !== "image/jpeg") {
            throw new Error("Unsupported image type");
          }
          setSource(`data:${image.mime};base64,${image.data}`);
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
    <figure
      class="semantic-figure"
      ref={(element) => {
        figure = element;
      }}
    >
      <div
        class="semantic-image-frame"
        style={{
          "aspect-ratio": `${Math.max(1, props.image.width)} / ${Math.max(1, props.image.height)}`,
        }}
      >
        {source() ? (
          <img src={source() || undefined} alt="Image extracted from the PDF" />
        ) : (
          <span class="muted">
            {error() || (props.image.object ? "Loading image..." : "Inline image unavailable")}
          </span>
        )}
      </div>
      {error() ? <figcaption role="status">{error()}</figcaption> : null}
    </figure>
  );
}

type ReadingEntry =
  | { type: "block"; y: number; block: SemanticBlock }
  | { type: "image"; y: number; image: SemanticImageRef };

type ReadingGroup =
  | { type: "block"; block: SemanticBlock }
  | { type: "image"; image: SemanticImageRef }
  | { type: "list"; blocks: SemanticBlock[] };

export function SemanticContent(props: ContentProps) {
  const entries: ReadingEntry[] = [
    ...props.page.blocks.map((block) => ({
      type: "block" as const,
      y: block.bbox[1],
      block,
    })),
    ...props.page.images.map((image) => ({
      type: "image" as const,
      y: image.bbox[1],
      image,
    })),
  ];
  entries.sort((a, b) => a.y - b.y);

  const groups: ReadingGroup[] = [];
  for (const entry of entries) {
    if (
      entry.type === "block" &&
      (entry.block.kind === "list_item" || entry.block.kind === "list-item")
    ) {
      const last = groups[groups.length - 1];
      if (last?.type === "list") last.blocks.push(entry.block);
      else groups.push({ type: "list", blocks: [entry.block] });
    } else if (entry.type === "block") {
      groups.push({ type: "block", block: entry.block });
    } else {
      groups.push({ type: "image", image: entry.image });
    }
  }

  const unusedLinks = props.page.links.filter(
    (_link, index) =>
      !props.page.blocks.some((block) => block.spans.some((span) => span.link === index)),
  );

  return (
    <div class="semantic-content">
      {props.page.refusal ? (
        <p class="page-error" role="status">
          Text unavailable: {props.page.refusal}
        </p>
      ) : null}
      {groups.map((group) => {
        if (group.type === "image") {
          return <SemanticImage image={group.image} root={props.root} />;
        }
        if (group.type === "list") {
          return (
            <ul>
              {group.blocks.map((block) => (
                <BlockContent block={block} page={props.page} navigate={props.navigate} />
              ))}
            </ul>
          );
        }
        return (
          <BlockContent block={group.block} page={props.page} navigate={props.navigate} />
        );
      })}
      {!props.page.refusal && groups.length === 0 ? (
        <p class="muted">This page has no extractable text or images.</p>
      ) : null}
      {unusedLinks.length > 0 ? (
        <nav class="page-links" aria-label="Page links">
          {unusedLinks.map((link) => {
            const index = targetPage(link.target);
            const text = index !== null ? `Go to page ${index + 1}` : link.target.uri || "Link";
            return (
              <SemanticAnchor target={link.target} text={text} navigate={props.navigate} />
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}


import { createSignal, onSettled } from "solid-js";
import type {
  Annotation,
  AnnotationInput,
  AnnotationKind,
  Color,
  DocumentProperties,
  EditState,
  InfoKey,
  SaveMode,
  Unlisten,
} from "./api";
import { api } from "./api";
import { message, schedule } from "./runtime";

export type EditTool = "select" | AnnotationKind;

const EMPTY_STATE: EditState = {
  dirty: false,
  can_undo: false,
  can_redo: false,
  path: null,
};

export const PROPERTY_FIELDS: {
  field: keyof DocumentProperties;
  key: InfoKey;
  label: string;
}[] = [
  { field: "title", key: "Title", label: "Title" },
  { field: "author", key: "Author", label: "Author" },
  { field: "subject", key: "Subject", label: "Subject" },
  { field: "keywords", key: "Keywords", label: "Keywords" },
];

interface EditorOptions {
  available: () => boolean;
  currentPage: () => number;
  navigate: (page: number) => void;
  changed: (pages: number) => void;
  organized: () => void;
  title: (title: string | null) => void;
  notify: () => void;
  error: (text: string) => void;
}

export function createEditor(options: EditorOptions) {
  const [enabled, setEnabled] = createSignal(false);
  const [tool, setTool] = createSignal<EditTool>("select");
  const [color, setColor] = createSignal<Color>([1, 0.85, 0]);
  const [opacity, setOpacity] = createSignal(1);
  const [busy, setBusy] = createSignal(false);
  const [state, setState] = createSignal<EditState>({ ...EMPTY_STATE });
  const [revision, setRevision] = createSignal(0);
  const [interaction, setInteraction] = createSignal(0);
  const [annotations, setAnnotations] = createSignal<Record<number, Annotation[]>>({});
  const [selected, setSelected] = createSignal<{ page: number; index: number } | null>(null);
  const [properties, setProperties] = createSignal<DocumentProperties | null>(null);
  const [propertiesOpen, setPropertiesOpen] = createSignal(false);
  const [dragging, setDragging] = createSignal<number | null>(null);
  const [status, setStatus] = createSignal("");
  let disposed = false;
  let epoch = 0;
  let refreshTicket = 0;

  function updateTitle(): void {
    try {
      const title = properties()?.title || "PDF Viewer";
      document.title = `${state().dirty ? "* " : ""}${title} | PDF Viewer`;
    } catch {
      // The embedded engine can expose document.title read-only.
    }
  }

  async function refresh(): Promise<void> {
    const document = epoch;
    const ticket = ++refreshTicket;
    const valid = () => !disposed && document === epoch && ticket === refreshTicket;
    try {
      const reply = await schedule(
        async () => ({ state: await api.editState(), properties: await api.info() }),
        valid,
      );
      if (!valid()) return;
      setState(reply.state);
      setProperties(reply.properties);
      options.title(reply.properties.title);
      updateTitle();
    } catch (reason) {
      if (valid()) options.error(message(reason));
    }
  }

  async function loadAnnotations(
    page: number,
    active: () => boolean = () => true,
  ): Promise<Annotation[]> {
    const document = epoch;
    const content = revision();
    const valid = () => !disposed && document === epoch && content === revision() && active();
    const found = await schedule(() => api.annotations(page), valid);
    if (valid()) setAnnotations((previous) => ({ ...previous, [page]: found }));
    return found;
  }

  function showPage(page: number): void {
    if (!enabled() || annotations()[page]) return;
    const document = epoch;
    const content = revision();
    const valid = () =>
      !disposed && document === epoch && content === revision() && options.currentPage() === page;
    void loadAnnotations(page, valid).catch((reason) => {
      if (valid()) options.error(message(reason));
    });
  }

  async function run(work: () => Promise<unknown>, organize = false): Promise<boolean> {
    if (busy() || !options.available() || disposed) return false;
    const document = epoch;
    const valid = () => !disposed && document === epoch;
    setBusy(true);
    options.error("");
    setStatus("");
    try {
      await schedule(work, valid);
      if (!valid()) return false;
      if (organize) options.organized();
      await refresh();
      return valid();
    } catch (reason) {
      if (valid()) options.error(message(reason));
      return false;
    } finally {
      if (valid()) setBusy(false);
    }
  }

  function disable(): void {
    setEnabled(false);
    setSelected(null);
    setDragging(null);
    setInteraction((value) => value + 1);
    options.notify();
  }

  function toggle(): void {
    if (enabled()) {
      disable();
      return;
    }
    if (!options.available()) return;
    setEnabled(true);
    setInteraction((value) => value + 1);
    showPage(options.currentPage());
    options.notify();
  }

  function chooseTool(value: EditTool): void {
    setTool(value);
    setSelected(null);
    setInteraction((previous) => previous + 1);
  }

  function select(page: number, annotation: number): void {
    setSelected({ page, index: annotation });
    options.navigate(page);
  }

  async function remove(page: number, annotation: number): Promise<boolean> {
    if (!annotations()[page]?.some((item) => item.index === annotation)) return false;
    return run(() => api.removeAnnotation(page, annotation));
  }

  function undo(): Promise<boolean> {
    if (!state().can_undo) return Promise.resolve(false);
    return run(() => api.undo(), true);
  }

  function redo(): Promise<boolean> {
    if (!state().can_redo) return Promise.resolve(false);
    return run(() => api.redo(), true);
  }

  function save(mode: SaveMode): Promise<boolean> {
    return run(async () => {
      const reply = await api.save(mode);
      if (!disposed) setStatus(`Saved ${reply.path}`);
    });
  }

  function saveEncryptedCopy(path: string, password: string): Promise<boolean> {
    return run(async () => {
      const save = api.saveEncryptedCopy;
      if (!save) throw new Error("Encrypted PDF saving is unavailable");
      const reply = await save(path, password);
      if (!disposed) setStatus(`Saved encrypted copy to ${reply.path}`);
    });
  }

  function keydown(event: KeyboardEvent): boolean {
    if (!options.available()) return false;
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.isContentEditable || !!target.closest("input, textarea, select"));
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === "s") {
      event.preventDefault();
      void save(event.shiftKey ? "copy" : "in_place");
      return true;
    }
    if (command && !typing && (key === "z" || key === "y")) {
      event.preventDefault();
      if (key === "y" || event.shiftKey) void redo();
      else void undo();
      return true;
    }
    if (
      enabled() &&
      !typing &&
      !command &&
      !event.altKey &&
      (key === "delete" || key === "backspace") &&
      selected()
    ) {
      event.preventDefault();
      const item = selected();
      if (item) void remove(item.page, item.index);
      return true;
    }
    return false;
  }

  function reset(): void {
    epoch++;
    refreshTicket++;
    setBusy(false);
    setState({ ...EMPTY_STATE });
    setProperties(null);
    setPropertiesOpen(false);
    setAnnotations({});
    setStatus("");
    setRevision((value) => value + 1);
    disable();
    void refresh();
  }

  onSettled(() => {
    let unlisten: Unlisten | undefined;
    void api
      .on("document_changed", (reply) => {
        if (disposed || !options.available()) return;
        if (!Number.isSafeInteger(reply.pages) || reply.pages < 0) {
          options.error("The document change reply is invalid");
          return;
        }
        setSelected(null);
        setDragging(null);
        setAnnotations({});
        setRevision((value) => value + 1);
        setInteraction((value) => value + 1);
        options.changed(reply.pages);
        void refresh();
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((reason) => {
        if (!disposed) options.error(message(reason));
      });
    return () => {
      disposed = true;
      epoch++;
      refreshTicket++;
      unlisten?.();
    };
  });

  return {
    enabled,
    tool,
    color,
    opacity,
    busy,
    state,
    revision,
    interaction,
    annotations,
    selected,
    properties,
    propertiesOpen,
    dragging,
    status,
    available: options.available,
    reset,
    toggle,
    disable,
    chooseTool,
    setColor,
    setOpacity,
    select,
    clearSelection: () => setSelected(null),
    showPage,
    loadAnnotations,
    annotate: (input: AnnotationInput) => run(() => api.annotate(input)),
    remove,
    rotate: (page: number, turns: number) => run(() => api.rotatePage(page, turns)),
    deletePage: (page: number) => run(() => api.deletePage(page), true),
    move: (from: number, to: number) =>
      from === to ? Promise.resolve(false) : run(() => api.movePage(from, to), true),
    insert: (path: string, at: number) => run(() => api.insertPdf(path, at), true),
    startDrag: (page: number) => setDragging(page),
    endDrag: () => setDragging(null),
    undo,
    redo,
    save,
    saveEncryptedCopy,
    encryptedSaveAvailable: () => api.saveEncryptedCopy !== undefined,
    keydown,
    openProperties: () =>
      run(async () => {
        setProperties(await api.info());
        setPropertiesOpen(true);
      }),
    closeProperties: () => setPropertiesOpen(false),
    applyProperties: async (values: Record<keyof DocumentProperties, string>) => {
      const before = properties();
      const success = await run(async () => {
        for (const item of PROPERTY_FIELDS) {
          const text = values[item.field];
          if (text !== (before?.[item.field] || "")) await api.setInfo(item.key, text);
        }
      });
      if (success) setPropertiesOpen(false);
      return success;
    },
  };
}

export type Editor = ReturnType<typeof createEditor>;

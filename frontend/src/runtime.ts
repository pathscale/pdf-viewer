const jobs: (() => Promise<void>)[] = [];
let running = false;

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let next = jobs.shift();
    while (next) {
      await next();
      next = jobs.shift();
    }
  } finally {
    running = false;
  }
}

// Native v1 commands share one open document. Keep rendering work serial and
// skip queued jobs whose page or document has already been disposed.
export function schedule<T>(work: () => Promise<T>, valid: () => boolean = () => true): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    jobs.push(async () => {
      if (!valid()) {
        reject(new Error("Request cancelled"));
        return;
      }
      try {
        const result = await work();
        if (!valid()) reject(new Error("Request cancelled"));
        else resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    void drain();
  });
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface WatchEntry {
  element: HTMLElement;
  change: (visible: boolean) => void;
  visible: boolean | undefined;
}

interface WatchGroup {
  entries: Set<WatchEntry>;
  check: () => void;
  dispose: () => void;
}

const fallbackGroups = new WeakMap<HTMLElement, WatchGroup>();

function checkEntry(entry: WatchEntry, root: HTMLElement): void {
  const bounds = entry.element.getBoundingClientRect();
  const viewport = root.getBoundingClientRect();
  const margin = viewport.height * 0.75;
  const visible =
    bounds.width > 0 &&
    bounds.height > 0 &&
    viewport.height > 0 &&
    bounds.bottom >= viewport.top - margin &&
    bounds.top <= viewport.bottom + margin;
  if (visible !== entry.visible) {
    entry.visible = visible;
    entry.change(visible);
  }
}

export function observeNear(
  element: HTMLElement,
  root: HTMLElement,
  change: (visible: boolean) => void,
): { check: () => void; dispose: () => void } {
  const entry: WatchEntry = { element, change, visible: undefined };
  const check = () => checkEntry(entry, root);

  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(
      (entries) => {
        const observation = entries[0];
        if (!observation) return;
        const visible = observation.isIntersecting;
        if (visible !== entry.visible) {
          entry.visible = visible;
          change(visible);
        }
      },
      { root, rootMargin: "75% 0%" },
    );
    observer.observe(element);
    const initial = window.setTimeout(check, 0);
    return {
      check,
      dispose() {
        window.clearTimeout(initial);
        observer.disconnect();
      },
    };
  }

  let group = fallbackGroups.get(root);
  if (!group) {
    const entries = new Set<WatchEntry>();
    let timer: number | undefined;
    const checkAll = () => {
      timer = undefined;
      for (const candidate of entries) checkEntry(candidate, root);
    };
    const request = () => {
      if (timer === undefined) timer = window.setTimeout(checkAll, 50);
    };
    root.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);
    group = {
      entries,
      check: request,
      dispose() {
        if (timer !== undefined) window.clearTimeout(timer);
        root.removeEventListener("scroll", request);
        window.removeEventListener("resize", request);
      },
    };
    fallbackGroups.set(root, group);
  }

  const activeGroup = group;
  activeGroup.entries.add(entry);
  activeGroup.check();
  return {
    check,
    dispose() {
      activeGroup.entries.delete(entry);
      if (activeGroup.entries.size === 0) {
        activeGroup.dispose();
        fallbackGroups.delete(root);
      }
    },
  };
}

export function deviceScale(): number {
  const ratio = window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export interface Preferences {
  view: "pages" | "reading";
  zoom: number;
  fitWidth: boolean;
  fontScale: number;
  theme: "light" | "dark";
}

const STORAGE_KEY = "pdf-toolkit-viewer.preferences.v1";

export const DEFAULT_PREFERENCES: Preferences = {
  view: "pages",
  zoom: 1,
  fitWidth: false,
  fontScale: 1,
  theme: "light",
};

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function readPreferences(): Preferences {
  const defaults = {
    ...DEFAULT_PREFERENCES,
    theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  } satisfies Preferences;

  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return defaults;
    const values = saved as Partial<Preferences>;
    return {
      view: values.view === "reading" ? "reading" : "pages",
      zoom:
        typeof values.zoom === "number" && Number.isFinite(values.zoom)
          ? clamp(values.zoom, 0.25, 4)
          : defaults.zoom,
      fitWidth: values.fitWidth === true,
      fontScale:
        typeof values.fontScale === "number" && Number.isFinite(values.fontScale)
          ? clamp(values.fontScale, 0.75, 1.75)
          : defaults.fontScale,
      theme: values.theme === "dark" ? "dark" : "light",
    };
  } catch {
    return defaults;
  }
}

export function applyPreferences(preferences: Preferences): void {
  const root = document.documentElement;
  root.dataset.theme = "pdf-viewer";
  root.dataset.colorMode = preferences.theme;
  root.style.fontSize = `${preferences.fontScale * 100}%`;
}

export function savePreferences(preferences: Preferences): void {
  applyPreferences(preferences);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A restricted storage environment still allows preferences for this session.
  }
}


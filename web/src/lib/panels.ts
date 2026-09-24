export type PanelId = "overview" | "search" | "history" | "owners" | "filters" | "chat";

export const PANELS: readonly { id: PanelId; title: string }[] = [
  { id: "overview", title: "Overview" },
  { id: "search", title: "Search" },
  { id: "history", title: "History" },
  { id: "owners", title: "Owners" },
  { id: "filters", title: "Filters" },
  { id: "chat", title: "Ask AI" },
];

export const DEFAULT_VISIBILITY: Record<PanelId, boolean> = {
  overview: true, search: true, history: true, owners: true, filters: false, chat: false,
};

export const STORAGE_KEY = "kessler.panels.v1";

export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadVisibility(storage: Pick<Storage, "getItem"> | null): Record<PanelId, boolean> {
  const out = { ...DEFAULT_VISIBILITY };
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const p of PANELS) {
        const v = (parsed as Record<string, unknown>)[p.id];
        if (typeof v === "boolean") out[p.id] = v;
      }
    }
  } catch {
    return { ...DEFAULT_VISIBILITY };
  }
  return out;
}

export function saveVisibility(storage: Pick<Storage, "setItem"> | null, v: Record<PanelId, boolean>): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    // Private mode / quota: keep the in-memory state only.
  }
}

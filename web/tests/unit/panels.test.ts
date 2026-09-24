import { describe, expect, it } from "vitest";
import { DEFAULT_VISIBILITY, loadVisibility, PANELS, saveVisibility, STORAGE_KEY } from "@/lib/panels";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("panels", () => {
  it("lists six panels in dock order with the spec defaults", () => {
    expect(PANELS.map((p) => p.id)).toEqual(["overview", "search", "history", "owners", "filters", "chat"]);
    expect(DEFAULT_VISIBILITY).toEqual({ overview: true, search: true, history: true, owners: true, filters: false, chat: false });
  });

  it("round-trips through storage", () => {
    const s = mem();
    saveVisibility(s, { ...DEFAULT_VISIBILITY, history: false, filters: true });
    expect(JSON.parse(s.m.get(STORAGE_KEY)!)).toMatchObject({ history: false, filters: true });
    expect(loadVisibility(s)).toEqual({ ...DEFAULT_VISIBILITY, history: false, filters: true });
  });

  it("falls back to defaults when storage throws", () => {
    const boom = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
    expect(loadVisibility(boom)).toEqual(DEFAULT_VISIBILITY);
    expect(() => saveVisibility(boom, DEFAULT_VISIBILITY)).not.toThrow();
    expect(loadVisibility(null)).toEqual(DEFAULT_VISIBILITY);
  });

  it("ignores corrupt JSON and unknown or non-boolean keys", () => {
    const s = mem();
    s.m.set(STORAGE_KEY, "{not json");
    expect(loadVisibility(s)).toEqual(DEFAULT_VISIBILITY);
    s.m.set(STORAGE_KEY, JSON.stringify({ owners: false, bogus: true, search: "yes" }));
    expect(loadVisibility(s)).toEqual({ ...DEFAULT_VISIBILITY, owners: false });
  });
});

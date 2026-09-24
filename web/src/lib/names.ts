import { api } from "@/lib/api";

type Group = "LEO" | "HIGH";
type Entry = { map: Map<number, string> | null; pending: Promise<Map<number, string> | null> | null; failedAt: number | null };

export function createNameCache(fetcher: (g: Group) => Promise<Record<string, string>>, now: () => number = Date.now, cooldownMs = 60_000) {
  const entries: Record<Group, Entry> = {
    LEO: { map: null, pending: null, failedAt: null },
    HIGH: { map: null, pending: null, failedAt: null },
  };
  return {
    peek: (g: Group) => entries[g].map,
    get(g: Group): Promise<Map<number, string> | null> {
      const e = entries[g];
      if (e.map) return Promise.resolve(e.map);
      if (e.pending) return e.pending;
      if (e.failedAt !== null && now() - e.failedAt < cooldownMs) return Promise.resolve(null);
      e.pending = fetcher(g)
        .then((names) => {
          e.map = new Map(Object.entries(names).map(([k, v]) => [Number(k), v]));
          e.failedAt = null;
          return e.map;
        })
        .catch(() => {
          e.failedAt = now();
          return null;
        })
        .finally(() => {
          e.pending = null;
        });
      return e.pending;
    },
  };
}

export const nameCache = createNameCache((g) => api.names(g));

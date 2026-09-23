import { create } from "zustand";
import { OBJECT_TYPES, type ObjectType, type Regime } from "@/lib/types";

type Orbits = { leo: boolean; high: boolean };
type Filters = { types: ObjectType[]; owners: string[]; orbits: Orbits };

interface ExplorerState extends Filters {
  selectedId: number | null;
  timeScale: 1 | 4320;
  toggleType: (t: ObjectType) => void;
  setOwners: (codes: string[]) => void;
  toggleOrbit: (k: keyof Orbits) => void;
  select: (id: number | null) => void;
  setTimeScale: (s: 1 | 4320) => void;
  reset: () => void;
}

const initial = (): Filters & Pick<ExplorerState, "selectedId" | "timeScale"> => ({
  types: [...OBJECT_TYPES],
  owners: [],
  orbits: { leo: true, high: false },
  selectedId: null,
  timeScale: 1,
});

export const useExplorer = create<ExplorerState>((set) => ({
  ...initial(),
  toggleType: (t) =>
    set((s) => {
      const has = s.types.includes(t);
      if (has && s.types.length === 1) return s;
      return { types: has ? s.types.filter((x) => x !== t) : OBJECT_TYPES.filter((x) => x === t || s.types.includes(x)) };
    }),
  setOwners: (codes) => set({ owners: codes }),
  toggleOrbit: (k) =>
    set((s) => {
      const next = { ...s.orbits, [k]: !s.orbits[k] };
      return next.leo || next.high ? { orbits: next } : s;
    }),
  select: (id) => set({ selectedId: id }),
  setTimeScale: (timeScale) => set({ timeScale }),
  reset: () => set(initial()),
}));

export function regimesFor(orbits: Orbits): Regime[] | undefined {
  if (orbits.leo && orbits.high) return undefined;
  return orbits.leo ? ["LEO"] : ["MEO", "GEO", "HEO"];
}

export function isVisible(
  record: { type: ObjectType; owner: string },
  group: "LEO" | "HIGH",
  s: Filters,
): boolean {
  if (group === "LEO" ? !s.orbits.leo : !s.orbits.high) return false;
  if (!s.types.includes(record.type)) return false;
  return s.owners.length === 0 || s.owners.includes(record.owner);
}

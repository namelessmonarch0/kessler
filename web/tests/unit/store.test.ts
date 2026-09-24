import { beforeEach, describe, expect, it } from "vitest";
import { isVisible, regimesFor, useExplorer } from "@/lib/store";

beforeEach(() => useExplorer.getState().reset());

describe("explorer store", () => {
  it("starts with all types, all owners and LEO only", () => {
    const s = useExplorer.getState();
    expect(s.types).toEqual(["PAY", "R/B", "DEB", "UNK"]);
    expect(s.owners).toEqual([]);
    expect(s.orbits).toEqual({ leo: true, high: false });
    expect(s.timeScale).toBe(1);
  });

  it("toggles types but never allows zero types", () => {
    const { toggleType } = useExplorer.getState();
    toggleType("DEB");
    expect(useExplorer.getState().types).toEqual(["PAY", "R/B", "UNK"]);
    toggleType("PAY"); toggleType("R/B"); toggleType("UNK");
    expect(useExplorer.getState().types).toEqual(["UNK"]);
  });

  it("never allows both orbit groups off", () => {
    useExplorer.getState().toggleOrbit("leo");
    expect(useExplorer.getState().orbits).toEqual({ leo: true, high: false });
    useExplorer.getState().toggleOrbit("high");
    useExplorer.getState().toggleOrbit("leo");
    expect(useExplorer.getState().orbits).toEqual({ leo: false, high: true });
  });
});

describe("regimesFor / isVisible", () => {
  it("maps orbit toggles to API regimes", () => {
    expect(regimesFor({ leo: true, high: false })).toEqual(["LEO"]);
    expect(regimesFor({ leo: false, high: true })).toEqual(["MEO", "GEO", "HEO"]);
    expect(regimesFor({ leo: true, high: true })).toBeUndefined();
  });

  it("filters by type, owner and orbit group", () => {
    const s = { types: ["PAY", "DEB"] as const, owners: ["US"], orbits: { leo: true, high: false } };
    expect(isVisible({ type: "PAY", owner: "US" }, "LEO", { ...s, types: [...s.types] })).toBe(true);
    expect(isVisible({ type: "R/B", owner: "US" }, "LEO", { ...s, types: [...s.types] })).toBe(false);
    expect(isVisible({ type: "PAY", owner: "PRC" }, "LEO", { ...s, types: [...s.types] })).toBe(false);
    expect(isVisible({ type: "PAY", owner: "US" }, "HIGH", { ...s, types: [...s.types] })).toBe(false);
  });
});

describe("panel visibility in the store", () => {
  it("starts from the defaults and toggles", () => {
    const s = useExplorer.getState();
    expect(s.panels.filters).toBe(false);
    s.togglePanel("filters");
    expect(useExplorer.getState().panels.filters).toBe(true);
    useExplorer.getState().setPanel("history", false);
    expect(useExplorer.getState().panels.history).toBe(false);
  });

  it("selecting an object reveals the search panel", () => {
    useExplorer.getState().setPanel("search", false);
    useExplorer.getState().select(25544);
    expect(useExplorer.getState().panels.search).toBe(true);
  });
});

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

describe("mobile sheet open state", () => {
  it("starts open, can be closed and reopened, and resets to open", () => {
    expect(useExplorer.getState().mobileSheetOpen).toBe(true);
    useExplorer.getState().setMobileSheetOpen(false);
    expect(useExplorer.getState().mobileSheetOpen).toBe(false);
    useExplorer.getState().setMobileSheetOpen(true);
    expect(useExplorer.getState().mobileSheetOpen).toBe(true);
    useExplorer.getState().setMobileSheetOpen(false);
    useExplorer.getState().reset();
    expect(useExplorer.getState().mobileSheetOpen).toBe(true);
  });
});

describe("mobile sheet measured top", () => {
  it("starts null (unmeasured), can be set and cleared, and resets to null", () => {
    expect(useExplorer.getState().mobileSheetTop).toBeNull();
    useExplorer.getState().setMobileSheetTop(505);
    expect(useExplorer.getState().mobileSheetTop).toBe(505);
    useExplorer.getState().setMobileSheetTop(null);
    expect(useExplorer.getState().mobileSheetTop).toBeNull();
    useExplorer.getState().setMobileSheetTop(322);
    useExplorer.getState().reset();
    expect(useExplorer.getState().mobileSheetTop).toBeNull();
  });
});

describe("top bar measured bottom", () => {
  it("starts null (unmeasured), can be set and cleared, and resets to null", () => {
    expect(useExplorer.getState().topBarBottom).toBeNull();
    useExplorer.getState().setTopBarBottom(92);
    expect(useExplorer.getState().topBarBottom).toBe(92);
    useExplorer.getState().setTopBarBottom(null);
    expect(useExplorer.getState().topBarBottom).toBeNull();
    useExplorer.getState().setTopBarBottom(80);
    useExplorer.getState().reset();
    expect(useExplorer.getState().topBarBottom).toBeNull();
  });
});

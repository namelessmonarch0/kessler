import { describe, expect, it } from "vitest";
import { HIDE_ABOVE, isOccluded, LABEL_MAX, labelsActive, pickLabels, SHOW_BELOW, type Candidate } from "@/lib/labels";

const W = 1000, H = 800;
const c = (id: number, x: number, y: number, extra: Partial<Candidate> = {}): Candidate => ({ id, x, y, name: `SAT ${id}`, color: "#fff", occluded: false, ...extra });

describe("labelsActive (hysteresis)", () => {
  it("turns on below 2.2 and off only above 2.4", () => {
    expect(SHOW_BELOW).toBe(2.2);
    expect(HIDE_ABOVE).toBe(2.4);
    expect(labelsActive(false, 2.3)).toBe(false);
    expect(labelsActive(false, 2.1)).toBe(true);
    expect(labelsActive(true, 2.3)).toBe(true);
    expect(labelsActive(true, 2.5)).toBe(false);
  });
});

describe("isOccluded", () => {
  it("is true when the Earth sits between camera and point", () => {
    expect(isOccluded([0, 0, 3], [0, 0, -1.1])).toBe(true);
  });
  it("is false for a point on the near side or off to the side", () => {
    expect(isOccluded([0, 0, 3], [0, 0, 1.1])).toBe(false);
    expect(isOccluded([0, 0, 3], [1.5, 0, -1])).toBe(false);
  });
});

describe("pickLabels", () => {
  it("ranks by distance to the screen centre and caps at 12", () => {
    const cands = Array.from({ length: 30 }, (_, i) => c(i, 500 + (i % 6) * 120 - 300, 400 + Math.floor(i / 6) * 60 - 120));
    const out = pickLabels(cands, { width: W, height: H, selectedId: null, charW: 1, lineH: 1 });
    expect(LABEL_MAX).toBe(12);
    expect(out.length).toBe(12);
    const d = (p: Candidate) => Math.hypot(p.x - W / 2, p.y - H / 2);
    expect(Math.max(...out.map(d))).toBeLessThanOrEqual(Math.min(...cands.filter((x) => !out.some((o) => o.id === x.id)).map(d)));
  });

  it("drops a label that would overlap a closer one", () => {
    const out = pickLabels([c(1, 500, 400), c(2, 505, 402)], { width: W, height: H, selectedId: null });
    expect(out.map((o) => o.id)).toEqual([1]);
  });

  it("always places the selected object first when visible", () => {
    const out = pickLabels([c(1, 500, 400), c(2, 900, 100)], { width: W, height: H, selectedId: 2, max: 1 });
    expect(out.map((o) => o.id)).toEqual([2]);
  });

  it("never labels occluded or off-screen objects, even when selected", () => {
    const out = pickLabels(
      [c(1, 500, 400, { occluded: true }), c(2, -20, 400), c(3, 500, 900), c(4, 520, 300)],
      { width: W, height: H, selectedId: 1 },
    );
    expect(out.map((o) => o.id)).toEqual([4]);
  });
});

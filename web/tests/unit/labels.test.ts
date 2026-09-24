import { describe, expect, it } from "vitest";
import { behindEarth, HIDE_ABOVE, isOccluded, LABEL_MAX, labelAnchor, labelsActive, pickLabels, SHOW_BELOW, type Candidate } from "@/lib/labels";

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

describe("behindEarth", () => {
  const cam: [number, number, number] = [0, 0, 3];

  it("is true for a point straight behind the Earth", () => {
    expect(behindEarth(cam, [0, 0, -1.1])).toBe(true);
  });

  it("is false for a point behind the centre plane but outside the radius-1 cylinder (near the limb)", () => {
    // along = -0.5 < 0 (behind the plane), but 1.3 off-axis puts it outside the cylinder.
    expect(behindEarth(cam, [1.3, 0, -0.5])).toBe(false);
  });

  it("is false for any point in front of the centre plane (p·ĉ > 0)", () => {
    expect(behindEarth(cam, [0, 0, 1.1])).toBe(false);
    expect(behindEarth(cam, [0.5, 0.5, 0.1])).toBe(false);
  });

  it("never rejects a point isOccluded says is visible, across a sampled grid", () => {
    for (let x = -2; x <= 2; x += 0.4) {
      for (let y = -2; y <= 2; y += 0.4) {
        for (let z = -2; z <= 2; z += 0.4) {
          const p: [number, number, number] = [x, y, z];
          if (behindEarth(cam, p)) expect(isOccluded(cam, p)).toBe(true);
        }
      }
    }
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

  // Phone: visible rect is the band between the top bar (bottom 90) and the sheet (top 500).
  const phone = { left: 0, top: 90, right: W, bottom: 500 };

  it("drops candidates outside the visible rect (under the top bar or the sheet), even when selected", () => {
    const out = pickLabels(
      [c(1, 500, 50), c(2, 500, 700, { name: "S" }), c(3, 500, 300)],
      { width: W, height: H, selectedId: 2, rect: phone },
    );
    expect(out.map((o) => o.id)).toEqual([3]);
  });

  it("ranks from the visible rect's centre, not the screen centre", () => {
    // rect centre is (500, 295); screen centre is (500, 400).
    const near = c(1, 500, 300), nearScreenCentre = c(2, 500, 420);
    const out = pickLabels([nearScreenCentre, near], { width: W, height: H, selectedId: null, max: 1, rect: phone });
    expect(out.map((o) => o.id)).toEqual([1]);
  });

  it("desktop: only the gap between the two panel columns counts", () => {
    const gap = { left: 360, top: 0, right: 640, bottom: H };
    const out = pickLabels([c(1, 100, 400), c(2, 900, 400), c(3, 500, 400)], { width: W, height: H, selectedId: null, rect: gap });
    expect(out.map((o) => o.id)).toEqual([3]);
  });

  it("defaults to the whole screen when no rect is given", () => {
    const out = pickLabels([c(1, 5, 30), c(2, 900, 795)], { width: W, height: H, selectedId: null });
    expect(out.map((o) => o.id).sort()).toEqual([1, 2]);
  });
});

describe("pickLabels pill must fit the visible rect", () => {
  it("drops a candidate whose pill would poke above the rect top (under the top bar) or past its right edge (under a panel)", () => {
    const rect = { left: 0, top: 90, right: 600, bottom: 500 };
    // Pill is 18px tall and sits 8px above the point: y=100 -> pill top 74 < 90.
    // "SAT 2" pill is 5*charW+12 wide from x+8: x=560 -> right edge 560+8+5*7.64+12 > 600.
    const out = pickLabels([c(1, 300, 100), c(2, 560, 300), c(3, 300, 300)], { width: W, height: H, selectedId: null, rect });
    expect(out.map((o) => o.id)).toEqual([3]);
  });
});

describe("labelAnchor", () => {
  it("offsets the pill 8px up-right of the object", () => {
    expect(labelAnchor(100, 200)).toEqual({ left: 108, top: 200 - 8 - 18 });
  });
});

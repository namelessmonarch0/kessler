import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applyFrame, artScale, buildObjectGeometry, dotScale, frameAlpha, lodFade, selectionScale, setVisibility, LOD_DOTS_BELOW_PX, LOD_ICONS_ABOVE_PX } from "@/components/globe/objectPoints";
import { kindColour, spriteRow } from "@/components/globe/spriteAtlas";
import { SPRITES, variantOf } from "@/components/globe/objectSprites";
import type { OrbitRecord } from "@/lib/snapshot";

const rec = (noradId: number, type: OrbitRecord["type"]) => ({ noradId, type }) as OrbitRecord;
const records = [rec(25544, "PAY"), rec(1001, "R/B"), rec(7, "DEB"), rec(8, "UNK")];

describe("buildObjectGeometry", () => {
  const g = buildObjectGeometry(records);
  const attr = (name: string) => Array.from(g.getAttribute(name).array as Float32Array);

  it("has one point per record", () => {
    expect(g.getAttribute("position").count).toBe(4);
    expect(g.getAttribute("aPrev").count).toBe(4);
  });
  it("assigns each object its type's sprite row and fixed variant", () => {
    expect(attr("aSprite")).toEqual([
      spriteRow("PAY", variantOf(25544, SPRITES.PAY.length)),
      spriteRow("RB", variantOf(1001, SPRITES.RB.length)),
      spriteRow("DEB", variantOf(7, SPRITES.DEB.length)),
      spriteRow("DEB", variantOf(8, SPRITES.DEB.length)),
    ]);
  });
  it("uses the sprite's dot size and the type's base colour for zoomed-out dots", () => {
    expect(attr("aDot")).toEqual([2, 2, SPRITES.DEB[variantOf(7, 6)].dot, SPRITES.DEB[variantOf(8, 6)].dot]);
    const c = kindColour("RB");
    expect(attr("aColor").slice(3, 6).map((v) => +v.toFixed(5))).toEqual([c.r, c.g, c.b].map((v) => +v.toFixed(5)));
  });
  it("has a fixed bounding sphere, so a NaN position (an object that can't be propagated) never reaches three's computeBoundingSphere", () => {
    const fresh = buildObjectGeometry(records);
    expect(fresh.boundingSphere?.center.toArray()).toEqual([0, 0, 0]);
    expect(fresh.boundingSphere?.radius).toBeGreaterThanOrEqual(100);
    const nan = new Float32Array(12).fill(Number.NaN);
    applyFrame(fresh, nan, nan);
    expect(fresh.boundingSphere?.radius).toBeGreaterThanOrEqual(100); // not recomputed from the NaNs
  });
  it("starts hidden until visibility is set", () => {
    expect(attr("aVisible")).toEqual([0, 0, 0, 0]);
    setVisibility(g, [true, false, true, true]);
    expect(attr("aVisible")).toEqual([1, 0, 1, 1]);
  });
});

describe("applyFrame", () => {
  it("uploads both frames the first time", () => {
    const g = buildObjectGeometry(records);
    const a = new Float32Array(12).fill(1);
    applyFrame(g, a, a);
    expect(g.getAttribute("aPrev").array).toBe(a);
    expect(g.getAttribute("position").array).toBe(a);
  });
  it("afterwards reuses the previous 'next' buffer as 'prev' and uploads only the new frame", () => {
    const g = buildObjectGeometry(records);
    const f1 = new Float32Array(12).fill(1), f2 = new Float32Array(12).fill(2), f3 = new Float32Array(12).fill(3);
    applyFrame(g, f1, f2);
    const nextAttr = g.getAttribute("position") as THREE.BufferAttribute;
    const nextVersion = nextAttr.version;
    applyFrame(g, f2, f3);
    const prevAttr = g.getAttribute("aPrev") as THREE.BufferAttribute;
    expect(prevAttr).toBe(nextAttr); // same GPU buffer, now used as 'prev'
    expect(prevAttr.version).toBe(nextVersion); // not re-uploaded
    expect(g.getAttribute("position").array).toBe(f3);
  });
});

describe("frameAlpha", () => {
  it("matches interpolate's factor, clamped to [0, 1.5]", () => {
    const f = { prev: new Float32Array(3), next: new Float32Array(3), prevTime: 1000, nextTime: 2000 };
    expect(frameAlpha(f, 1500)).toBe(0.5);
    expect(frameAlpha(f, 500)).toBe(0);
    expect(frameAlpha(f, 9000)).toBe(1.5);
    expect(frameAlpha({ ...f, nextTime: 1000 }, 1500)).toBe(1);
  });
});

describe("lodFade", () => {
  it("is dots when the Earth is small on screen and icons when it is large", () => {
    expect(lodFade(LOD_DOTS_BELOW_PX - 1)).toBe(0);
    expect(lodFade(LOD_ICONS_ABOVE_PX + 1)).toBe(1);
    const mid = lodFade((LOD_DOTS_BELOW_PX + LOD_ICONS_ABOVE_PX) / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe("zoom scaling", () => {
  it("grows icons smoothly (no steps) from 1.5 CSS px per sprite pixel up to a 6 px cap", () => {
    expect(artScale(LOD_DOTS_BELOW_PX)).toBeCloseTo(1.5, 5);
    expect(artScale(100)).toBe(1.5);
    expect(artScale(1e6)).toBe(6);
    const a = artScale(700), b = artScale(701);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeLessThan(0.01); // continuous: a 1 px zoom change moves the size by a sliver
    expect(artScale(4 * LOD_DOTS_BELOW_PX)).toBeCloseTo(3, 5); // square-root growth
  });
  it("grows dots gently from 1× at the default view to at most 2×", () => {
    expect(dotScale(265)).toBe(1);
    expect(dotScale(530)).toBeGreaterThan(1);
    expect(dotScale(1e6)).toBe(2);
  });
  it("keeps the selection at least 4.5 CSS px per sprite pixel and 1.5× its neighbours", () => {
    expect(selectionScale(1.5) * 1.5).toBeCloseTo(4.5, 5);
    expect(selectionScale(6)).toBe(1.5);
  });
});

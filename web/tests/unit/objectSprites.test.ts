import { describe, expect, it } from "vitest";
import { rotateCCW, spriteGrid, SPRITES, spriteKind, variantOf } from "@/components/globe/objectSprites";

const all = Object.values(SPRITES).flat();

describe("sprite data", () => {
  it("every drawing is rectangular and uses only . L M D", () => {
    for (const s of all) {
      for (const rows of [s.straight, s.diagonal].filter(Boolean) as string[][]) {
        expect(new Set(rows.map((r) => r.length)).size).toBe(1);
        for (const r of rows) expect(r).toMatch(/^[.LMD]+$/);
      }
    }
  });
  it("every sector fits a 16×16 atlas cell", () => {
    for (const s of all) for (let k = 0; k < 8; k++) {
      const g = spriteGrid(s, k);
      expect(g.length).toBeLessThanOrEqual(16);
      expect(g[0].length).toBeLessThanOrEqual(16);
    }
  });
  it("has the approved variant counts", () => {
    expect([SPRITES.PAY.length, SPRITES.RB.length, SPRITES.DEB.length]).toEqual([4, 2, 6]);
  });
});

describe("rotation", () => {
  it("turns a right-pointing sprite to point up", () => {
    expect(rotateCCW(["LMD"])).toEqual(["D", "M", "L"]);
  });
  it("four quarter turns return the original", () => {
    const rows = SPRITES.RB[0].straight;
    expect(rotateCCW(rotateCCW(rotateCCW(rotateCCW(rows))))).toEqual(rows);
  });
  it("maps sectors to straight and diagonal drawings", () => {
    const s = SPRITES.PAY[0];
    expect(spriteGrid(s, 0)).toEqual(s.straight);
    expect(spriteGrid(s, 1)).toEqual(s.diagonal);
    expect(spriteGrid(s, 2)).toEqual(rotateCCW(s.straight));
    expect(spriteGrid(s, 7)).toEqual(rotateCCW(rotateCCW(rotateCCW(s.diagonal!))));
    expect(spriteGrid(s, 8)).toEqual(s.straight);
  });
  it("debris reuses its straight drawing for diagonal sectors", () => {
    const d = SPRITES.DEB[0];
    expect(spriteGrid(d, 1)).toEqual(d.straight);
    expect(spriteGrid(d, 3)).toEqual(rotateCCW(d.straight));
  });
});

describe("variants", () => {
  it("are fixed per NORAD ID and in range", () => {
    expect(variantOf(25544, 4)).toBe(variantOf(25544, 4));
    for (const id of [0, 1, 7, 25544, 99999]) {
      expect(variantOf(id, 6)).toBeGreaterThanOrEqual(0);
      expect(variantOf(id, 6)).toBeLessThan(6);
    }
  });
  it("unknown objects draw as debris", () => {
    expect([spriteKind("PAY"), spriteKind("R/B"), spriteKind("DEB"), spriteKind("UNK")]).toEqual(["PAY", "RB", "DEB", "DEB"]);
  });
});

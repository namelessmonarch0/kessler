import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ATLAS_CELL, buildAtlas, SECTORS, SPRITE_COUNT, spriteRow, srgbBytes, tones } from "@/components/globe/spriteAtlas";
import { spriteGrid, SPRITES } from "@/components/globe/objectSprites";
import { GLOBE_COLORS } from "@/lib/types";

const hex = (c: THREE.Color) => `#${c.getHexString()}`;

describe("tones", () => {
  it("keeps the globe colour as the base tone and derives lighter and darker ones", () => {
    const t = tones(GLOBE_COLORS.DEB);
    expect(hex(t.M)).toBe(GLOBE_COLORS.DEB);
    const base = new THREE.Color(GLOBE_COLORS.DEB);
    expect(t.L.r + t.L.g + t.L.b).toBeGreaterThan(base.r + base.g + base.b);
    expect(t.D.r + t.D.g + t.D.b).toBeLessThan(base.r + base.g + base.b);
  });
});

describe("atlas", () => {
  const atlas = buildAtlas();
  const px = (x: number, y: number) => Array.from(atlas.data.slice((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4));

  it("holds 8 sector columns and one row per sprite", () => {
    expect(SPRITE_COUNT).toBe(12);
    expect(atlas.width).toBe(SECTORS * ATLAS_CELL);
    expect(atlas.height).toBe(SPRITE_COUNT * ATLAS_CELL);
    expect(atlas.data.length).toBe(atlas.width * atlas.height * 4);
  });

  it("gives each type its own rows in order", () => {
    expect([spriteRow("PAY", 0), spriteRow("PAY", 3), spriteRow("RB", 0), spriteRow("RB", 1), spriteRow("DEB", 0), spriteRow("DEB", 5)]).toEqual([0, 3, 4, 5, 6, 11]);
  });

  it("draws each sprite centred in its cell with the right tones", () => {
    for (const [kind, colour] of [["PAY", GLOBE_COLORS.PAY], ["RB", GLOBE_COLORS["R/B"]], ["DEB", GLOBE_COLORS.DEB]] as const) {
      const t = tones(colour);
      SPRITES[kind].forEach((sprite, v) => {
        for (let sector = 0; sector < SECTORS; sector++) {
          const g = spriteGrid(sprite, sector);
          const ox = sector * ATLAS_CELL + Math.floor((ATLAS_CELL - g[0].length) / 2);
          const oy = spriteRow(kind, v) * ATLAS_CELL + Math.floor((ATLAS_CELL - g.length) / 2);
          g.forEach((row, y) => [...row].forEach((ch, x) => {
            const p = px(ox + x, oy + y);
            if (ch === ".") expect(p[3]).toBe(0);
            else {
              expect(p).toEqual([...srgbBytes(t[ch as "L" | "M" | "D"]), 255]);
            }
          }));
        }
      });
    }
  });

  it("stores the base tone as its sRGB hex bytes", () => {
    expect(srgbBytes(new THREE.Color("#ff6a3d"))).toEqual([0xff, 0x6a, 0x3d]);
  });

  it("leaves cell corners empty", () => {
    expect(px(0, 0)[3]).toBe(0);
    expect(px(atlas.width - 1, atlas.height - 1)[3]).toBe(0);
  });
});

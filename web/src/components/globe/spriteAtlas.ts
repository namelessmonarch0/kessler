import * as THREE from "three";
import { GLOBE_COLORS } from "@/lib/types";
import { spriteGrid, SPRITES, type SpriteKind } from "@/components/globe/objectSprites";

/** Atlas cell size in sprite pixels (= CSS px on screen) and the number of screen directions per sprite. */
export const ATLAS_CELL = 16;
export const SECTORS = 8;

const KINDS: SpriteKind[] = ["PAY", "RB", "DEB"];
const KIND_COLOUR: Record<SpriteKind, string> = { PAY: GLOBE_COLORS.PAY, RB: GLOBE_COLORS["R/B"], DEB: GLOBE_COLORS.DEB };
const ROW_OFFSET = KINDS.reduce<Record<SpriteKind, number>>(
  (acc, k, i) => ({ ...acc, [k]: i === 0 ? 0 : acc[KINDS[i - 1]] + SPRITES[KINDS[i - 1]].length }),
  { PAY: 0, RB: 0, DEB: 0 },
);

export const SPRITE_COUNT = KINDS.reduce((n, k) => n + SPRITES[k].length, 0);

/** Atlas row (sprite index) of a type's variant. */
export const spriteRow = (kind: SpriteKind, variant: number) => ROW_OFFSET[kind] + variant;

/** The base colour of a sprite family, as used for the zoomed-out dots. */
export const kindColour = (kind: SpriteKind) => new THREE.Color(KIND_COLOUR[kind]);

/** Light, base and dark tones of a globe colour: the base is the colour itself, so each type's hue stays defined
 * in one place (GLOBE_COLORS). */
export function tones(hex: string): Record<"L" | "M" | "D", THREE.Color> {
  const M = new THREE.Color(hex);
  return { L: M.clone().lerp(new THREE.Color("#ffffff"), 0.55), M, D: M.clone().multiplyScalar(0.62) };
}

/** 8-bit sRGB channels of a colour (THREE.Color holds linear values; the atlas texture is sRGB). */
export const srgbBytes = (c: THREE.Color): [number, number, number] => {
  const h = c.getHex();
  return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
};

/** RGBA atlas: one column per screen sector, one row per sprite, each drawing centred in its 16×16 cell. Row 0 of
 * the data is the top of the atlas (sampled that way by the object shader). */
export function buildAtlas(): { data: Uint8Array; width: number; height: number } {
  const width = SECTORS * ATLAS_CELL, height = SPRITE_COUNT * ATLAS_CELL;
  const data = new Uint8Array(width * height * 4);
  for (const kind of KINDS) {
    const t = tones(KIND_COLOUR[kind]);
    SPRITES[kind].forEach((sprite, variant) => {
      for (let sector = 0; sector < SECTORS; sector++) {
        const g = spriteGrid(sprite, sector);
        const ox = sector * ATLAS_CELL + Math.floor((ATLAS_CELL - g[0].length) / 2);
        const oy = spriteRow(kind, variant) * ATLAS_CELL + Math.floor((ATLAS_CELL - g.length) / 2);
        g.forEach((row, y) =>
          [...row].forEach((ch, x) => {
            if (ch === ".") return;
            data.set([...srgbBytes(t[ch as "L" | "M" | "D"]), 255], ((oy + y) * width + ox + x) * 4);
          }),
        );
      }
    });
  }
  return { data, width, height };
}

/** The atlas as a nearest-filtered texture (pixel art: no smoothing, no mipmaps). */
export function createAtlasTexture(): THREE.DataTexture {
  const { data, width, height } = buildAtlas();
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

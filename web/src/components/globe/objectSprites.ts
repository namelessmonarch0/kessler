import type { ObjectType } from "@/lib/types";

/** Pixel-art sprite rows: "L" light, "M" base, "D" dark tone of the object type's globe colour; "." is empty.
 * `straight` points right (the direction of travel); `diagonal` points up-right. Rotating those by 90° steps gives
 * all 8 screen directions without resampling, so every angle stays pixel-crisp. Debris has no diagonal drawing:
 * it tumbles, so odd sectors reuse the nearest straight rotation. */
export type Sprite = { straight: string[]; diagonal?: string[]; dot: 1 | 2 };
export type SpriteKind = "PAY" | "RB" | "DEB";

export const SPRITES: Record<SpriteKind, Sprite[]> = {
  PAY: [
    {
      // winged satellite: two solar panels, body, antenna
      straight: [".....L.....", "MDM.LML.MDM", "MDMMMMMMMDM", "MDM.MMD.MDM", ".....D....."],
      diagonal: ["......DM.", ".....MDDM", "......MD.", "..L.LM...", "...LMD...", "...MMD...", ".DM......", "MDDM.....", ".MD......"],
      dot: 2,
    },
    {
      // flat panel (Starlink-style) with a short mast
      straight: ["LMMMMMMMMD", "....MD....", "....D....."],
      diagonal: ["......DD", ".....MM.", "....MM..", "...MMD..", "..MM.D..", ".MM.....", "LM......", "L......."],
      dot: 2,
    },
    {
      // cubesat
      straight: [".LL.", "LMMD", "MMMD", ".DD."],
      diagonal: [".L..", "LMM.", ".MMD", "..D."],
      dot: 2,
    },
    {
      // twin striped panels on a mast
      straight: ["..L..", "MDMDM", "MDMDM", "..D.."],
      diagonal: ["..LM.", ".MDMD", "MDMD.", ".DM.."],
      dot: 2,
    },
  ],
  RB: [
    {
      // spent stage: nozzle, body with a stage ring, rounded nose
      straight: ["..LLLLLLL.", "DDMMMLMMMM", "DDMMMDMMMD", "..DDDDDDD."],
      diagonal: [".......L.", "......LMD", ".....LMM.", "....LMMD.", "...LMDD..", "..LMMD...", ".DMMD....", "DDDD.....", ".D......."],
      dot: 2,
    },
    {
      // upper stage
      straight: [".LLLLL.", "DMMMMMM", ".DDDDD."],
      diagonal: ["..LLM", ".LLMD", "LLMDD", "LMDD.", "DDD.."],
      dot: 2,
    },
  ],
  DEB: [
    { straight: [".LM", "MMD", "D.."], dot: 2 },
    { straight: ["LM.", ".MD"], dot: 1 },
    { straight: ["LMD.", ".MDD"], dot: 2 },
    { straight: ["M", "D"], dot: 1 },
    { straight: ["LM", "MD"], dot: 1 },
    { straight: ["M"], dot: 1 },
  ],
};

/** Sprite family for an object type (unknown objects draw as debris, as before). */
export const spriteKind = (t: ObjectType): SpriteKind => (t === "PAY" ? "PAY" : t === "R/B" ? "RB" : "DEB");

/** Rotates rows 90° counter-clockwise as seen on screen (rows run top to bottom): a sprite pointing right ends up
 * pointing up. */
export function rotateCCW(rows: string[]): string[] {
  const h = rows.length, w = rows[0].length;
  return Array.from({ length: w }, (_, r) => Array.from({ length: h }, (_, c) => rows[c][w - 1 - r]).join(""));
}

const rotate = (rows: string[], quarterTurns: number) => {
  let out = rows;
  for (let i = 0; i < quarterTurns % 4; i++) out = rotateCCW(out);
  return out;
};

/** The sprite's rows for a screen sector: 0 = pointing right, counting counter-clockwise in 45° steps. */
export function spriteGrid(sprite: Sprite, sector: number): string[] {
  const s = ((sector % 8) + 8) % 8;
  if (s % 2 === 0) return rotate(sprite.straight, s / 2);
  return sprite.diagonal ? rotate(sprite.diagonal, (s - 1) / 2) : rotate(sprite.straight, (s - 1) / 2);
}

/** Fixed variant per object (by NORAD ID) so an object never changes shape between frames. */
export const variantOf = (noradId: number, count: number) => ((noradId % count) + count) % count;

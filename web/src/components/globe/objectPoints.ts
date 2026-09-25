import * as THREE from "three";
import type { OrbitRecord } from "@/lib/snapshot";
import { SPRITES, spriteKind, variantOf } from "@/components/globe/objectSprites";
import { kindColour, spriteRow } from "@/components/globe/spriteAtlas";

type Frames = { prev: Float32Array | null; next: Float32Array | null; prevTime: number; nextTime: number };

/** Earth radius on screen (CSS px) below which objects draw as dots, and above which they are all icons; in
 * between, a growing share of objects (fixed per object) switches to its icon. */
export const LOD_DOTS_BELOW_PX = 330;
export const LOD_ICONS_ABOVE_PX = 600;

/** Radius (Earth radii) of the fixed bounding sphere for an object cloud: beyond the farthest HIGH orbit drawn. */
export const OBJECT_CLOUD_RADIUS = 100;

export const lodFade = (earthRadiusPx: number) =>
  Math.min(Math.max((earthRadiusPx - LOD_DOTS_BELOW_PX) / (LOD_ICONS_ABOVE_PX - LOD_DOTS_BELOW_PX), 0), 1);

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Earth radius on screen (CSS px) at the default view; dots are 1× there. */
const DEFAULT_VIEW_PX = 265;

/** CSS px per sprite pixel: grows smoothly with the square root of the Earth's on-screen size, from 1.5 where icons
 * start to appear up to 6 when zoomed right in. */
export const artScale = (earthRadiusPx: number) => clamp(1.5 * Math.sqrt(earthRadiusPx / LOD_DOTS_BELOW_PX), 1.5, 6);

/** Zoomed-out dots grow gently too: 1× at the default view, up to 2×. */
export const dotScale = (earthRadiusPx: number) => clamp(Math.sqrt(earthRadiusPx / DEFAULT_VIEW_PX), 1, 2);

/** Extra scale for the selected object's sprite: at least 4.5 CSS px per sprite pixel, and 1.5× its neighbours. */
export const selectionScale = (art: number) => Math.max(4.5 / art, 1.5);

/** Interpolation factor between the two latest worker frames: the same factor `interpolate` uses. */
export function frameAlpha(f: Frames, timeMs: number): number {
  return f.nextTime > f.prevTime ? Math.min(Math.max((timeMs - f.prevTime) / (f.nextTime - f.prevTime), 0), 1.5) : 1;
}

/** One point per object. "position" holds the newer worker frame and "aPrev" the older; the shader interpolates
 * between them. Per-object sprite row, dot size and dot colour never change; visibility follows the filters. */
export function buildObjectGeometry(records: OrbitRecord[]): THREE.BufferGeometry {
  const n = records.length;
  const sprite = new Float32Array(n), dot = new Float32Array(n), color = new Float32Array(n * 3);
  records.forEach((r, i) => {
    const kind = spriteKind(r.type);
    const variant = variantOf(r.noradId, SPRITES[kind].length);
    sprite[i] = spriteRow(kind, variant);
    dot[i] = SPRITES[kind][variant].dot;
    const c = kindColour(kind);
    color.set([c.r, c.g, c.b], i * 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("aPrev", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("aSprite", new THREE.BufferAttribute(sprite, 1));
  g.setAttribute("aDot", new THREE.BufferAttribute(dot, 1));
  g.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
  g.setAttribute("aVisible", new THREE.BufferAttribute(new Float32Array(n), 1));
  // three computes a bounding sphere from "position" to depth-sort objects (even with frustum culling off).
  // An object that can't be propagated is NaN there — the shader hides it — which would make that sphere NaN
  // and log an error, so give the cloud a fixed sphere (scene units, Earth radius 1) covering every orbit drawn.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), OBJECT_CLOUD_RADIUS);
  return g;
}

export function setVisibility(g: THREE.BufferGeometry, visible: boolean[]): void {
  const attr = g.getAttribute("aVisible") as THREE.BufferAttribute;
  const a = attr.array as Float32Array;
  for (let i = 0; i < a.length; i++) a[i] = visible[i] ? 1 : 0;
  attr.needsUpdate = true;
}

/** Points the geometry at a new pair of worker frames. usePropagation hands over the old "next" array as the new
 * "prev", so the attribute already holding it on the GPU just changes role: one upload per worker tick. */
export function applyFrame(g: THREE.BufferGeometry, prev: Float32Array, next: Float32Array): void {
  const oldNext = g.getAttribute("position") as THREE.BufferAttribute;
  const oldPrev = g.getAttribute("aPrev") as THREE.BufferAttribute;
  if (oldNext.array === prev && prev !== next) {
    oldPrev.array = next;
    oldPrev.needsUpdate = true;
    g.setAttribute("aPrev", oldNext);
    g.setAttribute("position", oldPrev);
    return;
  }
  oldPrev.array = prev;
  oldPrev.needsUpdate = true;
  oldNext.array = next;
  oldNext.needsUpdate = true;
}

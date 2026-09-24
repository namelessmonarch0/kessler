export const LABEL_MAX = 12;
export const SHOW_BELOW = 2.2;
export const HIDE_ABOVE = 2.4;
export const LABEL_INTERVAL_MS = 250;

export function labelsActive(wasActive: boolean, cameraDistance: number): boolean {
  return wasActive ? cameraDistance <= HIDE_ABOVE : cameraDistance < SHOW_BELOW;
}

type V3 = [number, number, number];

/** True if the segment camera→point passes through the sphere (Earth) before reaching the point. */
export function isOccluded(cam: V3, p: V3, radius = 1): boolean {
  const d: V3 = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const b = 2 * (cam[0] * d[0] + cam[1] * d[1] + cam[2] * d[2]);
  const cc = cam[0] * cam[0] + cam[1] * cam[1] + cam[2] * cam[2] - radius * radius;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return false;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 && t < 1 - 1e-6;
}

/**
 * Cheap, conservative pre-filter for `isOccluded`: true whenever `p` is definitely hidden behind
 * the Earth from a camera outside the unit sphere, without the sqrt + quadratic solve isOccluded
 * needs. With ĉ = cam/|cam| (the camera's direction from the origin) and `along = p·ĉ`:
 *
 * - `along < 0` means p is on the far side of the plane through the origin perpendicular to the
 *   camera axis (the "centre plane") — behind Earth's centre as seen from the camera.
 * - The radius-1 cylinder around the camera axis, at that same plane (distance |cam| from the
 *   camera along the axis), sits entirely inside the camera's actual sphere-tangent shadow cone:
 *   that cone has apex at the camera and half-angle α = asin(1/|cam|), so its radius at the
 *   centre plane is 1/cos(α) = 1/sqrt(1 − 1/|cam|²) — strictly greater than 1 whenever |cam| > 1
 *   (camera outside the sphere) — and only widens further behind that plane. So any point behind
 *   the centre plane and within the radius-1 cylinder is necessarily inside the (wider) real
 *   shadow cone, i.e. occluded. This is a sufficient, not exhaustive, test: it misses points the
 *   real cone also hides (e.g. near the tangent boundary, or behind the plane but outside the
 *   cylinder) — those still get caught by `isOccluded`.
 */
export function behindEarth(cam: V3, p: V3): boolean {
  const camLen = Math.hypot(cam[0], cam[1], cam[2]);
  if (camLen === 0) return false;
  const c: V3 = [cam[0] / camLen, cam[1] / camLen, cam[2] / camLen];
  const along = p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
  if (along >= 0) return false;
  const perp: V3 = [p[0] - along * c[0], p[1] - along * c[1], p[2] - along * c[2]];
  return perp[0] * perp[0] + perp[1] * perp[1] + perp[2] * perp[2] < 1;
}

export type Candidate = { id: number; x: number; y: number; name: string; color: string; occluded: boolean };
export type Placed = Candidate & { left: number; top: number };

export function pickLabels(
  cands: Candidate[],
  opts: { width: number; height: number; selectedId: number | null; max?: number; charW?: number; lineH?: number },
): Placed[] {
  const { width, height, selectedId, max = LABEL_MAX, charW = 7.64, lineH = 14 } = opts;
  const onScreen = cands.filter((c) => !c.occluded && c.x >= 0 && c.x <= width && c.y >= 0 && c.y <= height);
  const cx = width / 2, cy = height / 2;
  const ranked = onScreen
    .map((c) => ({ c, d: Math.hypot(c.x - cx, c.y - cy) }))
    .sort((a, b) => a.d - b.d)
    .map((r) => r.c);
  const sel = ranked.findIndex((c) => c.id === selectedId);
  if (sel > 0) ranked.unshift(ranked.splice(sel, 1)[0]);
  const placed: Placed[] = [];
  const boxes: { l: number; t: number; r: number; b: number }[] = [];
  for (const c of ranked) {
    if (placed.length >= max) break;
    const w = c.name.length * charW + 12, h = lineH + 4;
    const left = c.x + 8, top = c.y - 8 - h;
    const box = { l: left, t: top, r: left + w, b: top + h };
    if (boxes.some((o) => box.l < o.r && o.l < box.r && box.t < o.b && o.t < box.b)) continue;
    boxes.push(box);
    placed.push({ ...c, left, top });
  }
  return placed;
}

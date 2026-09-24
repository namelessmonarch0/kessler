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

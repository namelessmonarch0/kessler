export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= max) return m * exp;
  return 10 * exp;
}

export function yTicks(max: number): number[] {
  return [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
}

/** Departure Mono is monospaced at 12px; this is a cheap, dependency-free width estimate. */
export const CHAR_W = 7.2;

const ANNOTATION_ROWS = 4;
const ANNOTATION_GAP = 8;

export interface LaidOutAnnotation {
  year: number;
  label: string;
  x: number;
  row: number;
  anchor: "start" | "end";
}

export function layoutAnnotations(
  items: { year: number; label: string }[],
  xOf: (year: number) => number,
  left: number,
  right: number,
): LaidOutAnnotation[] {
  void right;
  const placed: { row: number; x0: number; x1: number }[] = [];
  const result: LaidOutAnnotation[] = [];
  for (const item of items) {
    const x = xOf(item.year);
    const w = item.label.length * CHAR_W;
    let anchor: "start" | "end" = "end";
    let x0 = x - w;
    let x1 = x;
    if (x0 < left) {
      anchor = "start";
      x0 = x;
      x1 = x + w;
    }
    let row = 0;
    for (; row < ANNOTATION_ROWS; row++) {
      const overlaps = placed.some(
        (p) => p.row === row && !(x1 + ANNOTATION_GAP <= p.x0 || p.x1 + ANNOTATION_GAP <= x0),
      );
      if (!overlaps) break;
    }
    if (row >= ANNOTATION_ROWS) row = ANNOTATION_ROWS - 1;
    placed.push({ row, x0, x1 });
    result.push({ year: item.year, label: item.label, x, row, anchor });
  }
  return result;
}

export function labelColumn(labels: string[], width: number): { marginLeft: number; display: string[] } {
  const PAD = 18;
  const longest = Math.max(0, ...labels.map((l) => l.length));
  const marginLeft = Math.min(longest * CHAR_W + PAD, Math.round(width * 0.38));
  const avail = Math.max(0, marginLeft - PAD);
  const maxChars = Math.max(1, Math.floor(avail / CHAR_W));
  const display = labels.map((l) => (l.length <= maxChars ? l : `${l.slice(0, Math.max(0, maxChars - 1))}…`));
  return { marginLeft, display };
}

export function yearTicks(first: number, last: number, xOf: (year: number) => number, minGapPx = 44): number[] {
  if (first === last) return [first];
  const plotWidth = xOf(last) - xOf(first);
  const step = plotWidth > 700 ? 10 : 20;
  const interior: number[] = [];
  for (let y = Math.ceil(first / step) * step; y < last; y += step) {
    if (y > first) interior.push(y);
  }
  const kept: number[] = [first];
  for (const y of interior) {
    if (xOf(y) - xOf(kept[kept.length - 1]) >= minGapPx) kept.push(y);
  }
  if (kept[kept.length - 1] !== first && xOf(last) - xOf(kept[kept.length - 1]) < minGapPx) {
    kept.pop();
  }
  kept.push(last);
  return kept;
}

export function tooltipPosition(
  x: number,
  y: number,
  vw: number,
  vh: number,
  w: number,
  h: number,
): { left: number; top: number } {
  const OFFSET = 14;
  const PAD = 8;
  let left = x + OFFSET;
  if (left + w > vw - PAD) left = x - OFFSET - w;
  let top = y + OFFSET;
  if (top + h > vh - PAD) top = y - OFFSET - h;
  left = Math.min(Math.max(left, PAD), Math.max(PAD, vw - PAD - w));
  top = Math.min(Math.max(top, PAD), Math.max(PAD, vh - PAD - h));
  return { left, top };
}

export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= max) return m * exp;
  return 10 * exp;
}

const Y_TICK_CANDIDATES = [1, 2, 2.5, 5];

/**
 * Picks a "nice" step (1/2/2.5/5 × 10ⁿ) that divides `max` evenly into 3-5
 * intervals (4-6 ticks including 0 and max), preferring the finest such step.
 * Searches the exponent of `max` and one order of magnitude below it, since
 * niceMax's mantissas (1/2/2.5/5/10) only ever need a step from one of those
 * two magnitudes to land in range.
 */
export function yTicks(max: number): number[] {
  if (max <= 0) return [0];
  const baseExp = Math.pow(10, Math.floor(Math.log10(max)));
  let step: number | null = null;
  for (const exp of [baseExp, baseExp / 10]) {
    for (const c of Y_TICK_CANDIDATES) {
      const candidate = c * exp;
      const intervals = max / candidate;
      const rounded = Math.round(intervals);
      if (Math.abs(intervals - rounded) < 1e-9 && rounded >= 3 && rounded <= 5) {
        if (step === null || candidate < step) step = candidate;
      }
    }
  }
  const finalStep = step ?? max / 4;
  const n = Math.round(max / finalStep);
  return Array.from({ length: n + 1 }, (_, i) => Math.round(i * finalStep * 1e6) / 1e6);
}

/**
 * Departure Mono px-per-character at 12px: measured with fonttools on
 * DepartureMono-Regular.woff2 — unitsPerEm 550, glyph advance 350 —
 * so advance = 350 / 550 em × 12px.
 */
export const CHAR_W = (350 / 550) * 12;

/**
 * Owner-name column in the bar chart (see labelColumn below) renders in Inter Tight SemiBold
 * (600) at 13px, not Departure Mono — a proportional, bolder face has no single exact advance
 * width, so this is a deliberately generous per-character estimate (wider than a typical
 * lowercase-heavy average) that errs toward reserving more room rather than clipping a label;
 * LABEL_RESERVE below adds further slack for real (kerning-affected) rendering.
 */
const OWNER_CHAR_W = 8;

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
      if (x1 > right) {
        // A start anchor doesn't fit either (label wider than the plot area). The row search
        // below still runs — a different row can't change the horizontal overflow, so as a last
        // resort clamp back to an end anchor, which is the least-bad option (labels wide enough
        // to trigger this are rare and the "end" side is what real annotation text is tuned for).
        anchor = "end";
        x0 = x - w;
        x1 = x;
      }
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

// Reserved gap between the label text and the bars, plus slack for CHAR_W's estimation error
// against real (kerning-affected) glyph rendering.
const LABEL_RESERVE = 24;
// The fits-check uses a slightly smaller reservation than LABEL_RESERVE (~4px less), so the
// longest label — the one that sized marginLeft in the first place — is never flagged as
// needing truncation by its own rounding.
const LABEL_CHECK_RESERVE = LABEL_RESERVE - 4;

export function labelColumn(labels: string[], width: number): { marginLeft: number; display: string[] } {
  const longest = Math.max(0, ...labels.map((l) => l.length));
  const marginLeft = Math.min(Math.ceil(longest * OWNER_CHAR_W) + LABEL_RESERVE, Math.round(width * 0.38));
  const avail = Math.max(0, marginLeft - LABEL_CHECK_RESERVE);
  const maxChars = Math.max(1, Math.floor(avail / OWNER_CHAR_W));
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

import { describe, expect, it } from "vitest";
import { earthRadiusPx, initialDistance, sheetInitialDistance, sheetMaxFraction, sheetViewOffset, sheetWorstCaseHeight } from "@/lib/camera";

// Replays three.js PerspectiveCamera.updateProjectionMatrix's view-offset math (near=1, so the
// near-plane bounds double as tangent values).
function projectedFrustum(width: number, height: number, fovDeg: number, offset: ReturnType<typeof sheetViewOffset>) {
  const fov = (fovDeg * Math.PI) / 180;
  const aspect = width / height;
  let top = Math.tan(fov / 2);
  let h = 2 * top;
  let w = aspect * h;
  let left = -0.5 * w;
  if (offset) {
    left += (offset.offsetX * w) / offset.fullWidth;
    top -= (offset.offsetY * h) / offset.fullHeight;
    w *= offset.viewWidth / offset.fullWidth;
    h *= offset.viewHeight / offset.fullHeight;
  }
  return { left, top, w, h };
}

describe("initialDistance", () => {
  it("frames the Earth at ~60% of the vertical field on landscape screens", () => {
    // vfov 40° -> target 24° -> d = 1 / sin(12°)
    expect(initialDistance(16 / 9)).toBeCloseTo(1 / Math.sin((12 * Math.PI) / 180), 3);
  });
  it("uses the narrower horizontal field on portrait phones", () => {
    const hfov = 2 * Math.atan(Math.tan((20 * Math.PI) / 180) * 0.46);
    expect(initialDistance(0.46)).toBeCloseTo(1 / Math.sin((0.6 * hfov) / 2), 3);
  });
});

describe("sheetViewOffset", () => {
  it("returns null for a degenerate (zero-size) canvas", () => {
    expect(sheetViewOffset(0, 844, 90, 500)).toBeNull();
    expect(sheetViewOffset(390, 0, 90, 500)).toBeNull();
  });

  it("is a pure shift: full size equals view size, no horizontal offset", () => {
    const o = sheetViewOffset(390, 844, 90, 500)!;
    expect(o).toEqual({ fullWidth: 390, fullHeight: 844, offsetX: 0, offsetY: 844 / 2 - (90 + 500) / 2, viewWidth: 390, viewHeight: 844 });
  });

  // The Earth (world origin, on the optical axis) must land exactly on the midpoint between the
  // top bar's bottom and the sheet's top, and the frustum must not be scaled at all — so a taller
  // sheet only moves the Earth, it never magnifies it.
  it.each([
    [390, 844, 92, 505],
    [390, 844, 92, 322],
    [768, 1024, 96, 402],
    [844, 390, 60, 187],
  ])("centres the origin between top bar and sheet without scaling (%ix%i, bar %i, sheet %i)", (w, h, bar, sheet) => {
    const offset = sheetViewOffset(w, h, bar, sheet);
    const plain = projectedFrustum(w, h, 40, null);
    const shifted = projectedFrustum(w, h, 40, offset);
    const row = (h * shifted.top) / shifted.h;
    expect(row).toBeCloseTo((bar + sheet) / 2, 6);
    expect(shifted.w).toBeCloseTo(plain.w, 12);
    expect(shifted.h).toBeCloseTo(plain.h, 12);
  });
});

describe("sheetMaxFraction / sheetWorstCaseHeight", () => {
  it("uses the 60dvh sheet ceiling, or 50dvh on short (<560px) viewports", () => {
    expect(sheetMaxFraction(844)).toBe(0.6);
    expect(sheetMaxFraction(560)).toBe(0.6);
    expect(sheetMaxFraction(559)).toBe(0.5);
  });
  it("is the space between the top bar and the tallest possible sheet (H - bar - (frac*H + 8))", () => {
    expect(sheetWorstCaseHeight(844, 92)).toBeCloseTo(844 - 92 - (0.6 * 844 + 8), 9);
    expect(sheetWorstCaseHeight(390, 60)).toBeCloseTo(390 - 60 - (0.5 * 390 + 8), 9);
    expect(sheetWorstCaseHeight(300, 400)).toBe(0);
  });
});

describe("sheetInitialDistance", () => {
  it("depends only on the viewport and the top bar, not on any sheet measurement", () => {
    // Signature has no sheet argument at all; same inputs -> same distance.
    expect(sheetInitialDistance(390, 844, 92)).toBe(sheetInitialDistance(390, 844, 92));
  });

  // With the tallest sheet the layout allows (60dvh + 8px margin), the Earth — centred by
  // sheetViewOffset in the gap — must fit inside it: top edge below the top bar, bottom edge
  // above the sheet, and inside the width.
  it.each([
    [390, 844, 92],
    [360, 780, 92],
    [768, 1024, 96],
    [640, 900, 96],
    [844, 390, 60],
  ])("fits the Earth inside the worst-case gap (%ix%i, bar %i)", (w, h, bar) => {
    const d = sheetInitialDistance(w, h, bar);
    const r = earthRadiusPx(d, h);
    const sheetTop = h - (sheetMaxFraction(h) * h + 8);
    const cy = (bar + sheetTop) / 2;
    expect(cy - r).toBeGreaterThanOrEqual(bar);
    expect(cy + r).toBeLessThanOrEqual(sheetTop);
    expect(2 * r).toBeLessThanOrEqual(w);
    // ...and it isn't needlessly tiny: fills 90% of the tighter dimension.
    expect(2 * r).toBeCloseTo(0.9 * Math.min(w, sheetWorstCaseHeight(h, bar)), 6);
  });
});

describe("earthRadiusPx", () => {
  it("matches the frustum projection of the unit sphere's silhouette", () => {
    // d = 1/sin(12°): silhouette half-angle 12°, tan(12°)/tan(20°) of half the screen height.
    const d = 1 / Math.sin((12 * Math.PI) / 180);
    expect(earthRadiusPx(d, 900)).toBeCloseTo((Math.tan((12 * Math.PI) / 180) / Math.tan((20 * Math.PI) / 180)) * 450, 6);
  });
});

import { describe, expect, it } from "vitest";
import { coveredHeightFromSheetTop, initialDistance, phoneInitialDistance, phoneViewOffset } from "@/lib/camera";

// Replays three.js PerspectiveCamera.updateProjectionMatrix's view-offset math (near=1, so the
// near-plane bounds double as tangent values). Shared by the phoneViewOffset and phone-framing
// integration tests below.
function projectedFrustum(width: number, height: number, fovDeg: number, offset: ReturnType<typeof phoneViewOffset>) {
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

describe("coveredHeightFromSheetTop", () => {
  it("is 0 before a measurement arrives", () => {
    expect(coveredHeightFromSheetTop(844, null)).toBe(0);
  });
  it("is the gap between the screen height and the sheet's measured top", () => {
    // Sheet's real top at row 505 (e.g. a short Overview tab, not the 60dvh max) -> covers 339px.
    expect(coveredHeightFromSheetTop(844, 505)).toBe(339);
  });
  it("clamps to 0 rather than going negative (sheet top below the viewport)", () => {
    expect(coveredHeightFromSheetTop(844, 900)).toBe(0);
  });
});

describe("phoneViewOffset", () => {
  it("returns null when there is nothing covered (sheet closed / desktop)", () => {
    expect(phoneViewOffset(390, 844, 0)).toBeNull();
    expect(phoneViewOffset(390, 844, -1)).toBeNull();
  });

  it("returns null for a degenerate (zero-size) canvas", () => {
    expect(phoneViewOffset(0, 844, 100)).toBeNull();
    expect(phoneViewOffset(390, 0, 100)).toBeNull();
  });

  // Checks the two properties phoneViewOffset is built to guarantee: the on-axis object (the
  // Earth, at the world origin) ends up at the vertical centre of the *uncovered* area, and the
  // frustum's aspect ratio (width/height) is unchanged by the offset, i.e. the globe isn't
  // stretched.
  it.each([
    [390, 844, 522.4],
    [412, 915, 200],
    [360, 780, 468],
  ])("centres the origin above the covered band and keeps the aspect ratio (%ipx x %ipx, covered %i)", (width, height, covered) => {
    const offset = phoneViewOffset(width, height, covered);
    expect(offset).not.toBeNull();
    const noOffset = projectedFrustum(width, height, 40, null);
    const withOffset = projectedFrustum(width, height, 40, offset);
    // Pixel row (from the top of the rendered window) that the on-axis object (near-plane y=0)
    // projects to: newTop maps to row 0, (newTop - h) maps to row `height`.
    const row = (height * withOffset.top) / withOffset.h;
    expect(row).toBeCloseTo((height - covered) / 2, 6);
    // No stretch: the ratio of frustum width to height is the same with and without the offset.
    expect(withOffset.w / withOffset.h).toBeCloseTo(noOffset.w / noOffset.h, 10);
  });
});

describe("phoneInitialDistance", () => {
  it("matches initialDistance exactly when there is nothing covered", () => {
    expect(phoneInitialDistance(390, 844, 0)).toBeCloseTo(initialDistance(390 / 844), 10);
    expect(phoneInitialDistance(390, 844, -1)).toBeCloseTo(initialDistance(390 / 844), 10);
  });

  it("moves the camera further back as more of the screen is covered", () => {
    const a = phoneInitialDistance(390, 844, 200);
    const b = phoneInitialDistance(390, 844, 500);
    const base = phoneInitialDistance(390, 844, 0);
    expect(a).toBeGreaterThan(base);
    expect(b).toBeGreaterThan(a);
  });

  // The real proof this fixes the "globe cropped on every edge" bug: replay the actual post-offset
  // frustum (the same math phoneViewOffset is built against) and check the Earth's near-plane
  // silhouette — diameter 2 * tan(asin(1 / distance)), exactly, for an on-axis sphere of radius 1
  // — is exactly 60% of the narrower visible extent, and therefore (being centred by
  // phoneViewOffset) never exceeds half of either extent, i.e. is never clipped.
  it.each([
    [390, 844, 522.4],
    [412, 915, 200],
    [360, 780, 468],
  ])("sizes the Earth to exactly 60%% of the narrower visible extent, never clipped (%ipx x %ipx, covered %i)", (width, height, covered) => {
    const distance = phoneInitialDistance(width, height, covered);
    const offset = phoneViewOffset(width, height, covered);
    const frustum = projectedFrustum(width, height, 40, offset);
    const theta = Math.asin(1 / distance);
    const diameter = 2 * Math.tan(theta);
    expect(diameter).toBeCloseTo(0.6 * Math.min(frustum.h, frustum.w), 9);
    expect(diameter / 2).toBeLessThanOrEqual(frustum.h / 2);
    expect(diameter / 2).toBeLessThanOrEqual(frustum.w / 2);
  });

  it("sheet-open worst case still fits once the sheet is later closed (more room, never less)", () => {
    const width = 390, height = 844;
    const distance = phoneInitialDistance(width, height, coveredHeightFromSheetTop(height, 322)); // realistic measured top
    const closedFrustum = projectedFrustum(width, height, 40, null); // sheet closed: no offset
    const theta = Math.asin(1 / distance);
    const diameter = 2 * Math.tan(theta);
    expect(diameter / 2).toBeLessThan(closedFrustum.h / 2);
    expect(diameter / 2).toBeLessThan(closedFrustum.w / 2);
  });
});

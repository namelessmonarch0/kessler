/** Camera distance (Earth radii) at which the Earth spans ~60% of the smaller field of view. */
export function initialDistance(aspect: number, fovDeg = 40): number {
  const v = (fovDeg * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  return 1 / Math.sin((0.6 * Math.min(v, h)) / 2);
}

/** Pixel height, at the bottom of a phone screen, that the bottom sheet (see MobileSheet.tsx)
 * covers while open: its `max-h-[60dvh]` allotment plus its own `bottom-2` (8px) inset. 0 when
 * closed (or on tablet/desktop, which never call this) — nothing to clear in that case. */
export function sheetCoveredHeight(screenHeight: number, sheetOpen: boolean): number {
  return sheetOpen ? screenHeight * 0.6 + 16 : 0;
}

/** Parameters for `THREE.PerspectiveCamera#setViewOffset(fullWidth, fullHeight, x, y, width,
 * height)` that push the camera's optical centre up by half of `coveredHeight`, so an object at
 * the world origin (the Earth) renders centred in the region of the canvas *above* whatever's
 * covered at the bottom (the phone sheet), instead of centred on the full canvas.
 *
 * Derivation: three.js's PerspectiveCamera builds a full symmetric frustum from fov/aspect, then
 * (with a view offset set) does `top -= offsetY * height / fullHeight` and `height *= viewHeight /
 * fullHeight` before using the result as the near-plane bounds. Solving for the on-axis object's
 * resulting pixel row with `offsetY = coveredHeight` and `fullHeight = height + coveredHeight`
 * gives exactly `(height - coveredHeight) / 2` — the vertical centre of the area above the
 * covered band. `fullWidth` is grown by that same `fullHeight / height` factor (and `offsetX`
 * centred within it) purely so the width and height frustum bounds are scaled by the same ratio;
 * three.js scales each axis independently, and without this the shift would stretch the globe
 * vertically instead of just moving it. tests/unit/camera.test.ts replays this frustum math
 * directly to check both properties (the target row, and the unchanged aspect).
 *
 * Returns null when there's nothing to correct for; callers should `clearViewOffset()` then. */
export function phoneViewOffset(
  width: number,
  height: number,
  coveredHeight: number,
): { fullWidth: number; fullHeight: number; offsetX: number; offsetY: number; viewWidth: number; viewHeight: number } | null {
  if (coveredHeight <= 0 || width <= 0 || height <= 0) return null;
  const fullHeight = height + coveredHeight;
  const zoom = fullHeight / height;
  const fullWidth = width * zoom;
  return { fullWidth, fullHeight, offsetX: (fullWidth - width) / 2, offsetY: coveredHeight, viewWidth: width, viewHeight: height };
}

/** Camera distance (Earth radii) that sizes the Earth to fill `fill` (default 0.6, matching
 * `initialDistance`'s 60%) of the narrower dimension of the area actually visible above a phone's
 * bottom sheet, once `phoneViewOffset`'s shift is applied.
 *
 * `initialDistance` targets 60% of the field of view's *angle*, which assumes a frustum symmetric
 * about the optical axis. `phoneViewOffset`'s frustum isn't symmetric (it's shifted up to clear
 * the sheet), so this instead targets 60% of the visible window's near-plane *screen extent*
 * directly (`viewHeight/fullHeight` and `viewWidth/fullWidth`, the multiplicative — not
 * shift-affected — scaling `updateProjectionMatrix` applies to the frustum's width/height): the
 * object's near-plane silhouette diameter is exactly `2 * tan(asin(1/d))`, so solving
 * `2 * tan(theta) = fill * min(hNew, wNew)` for `d = 1 / sin(theta)` sizes it to fill that
 * fraction without ever exceeding half of either extent (so, combined with `phoneViewOffset`'s
 * exact centring, it can't be clipped by the visible window's edges either).
 *
 * Falls back to exactly `initialDistance(width / height, fovDeg)` when there's nothing covered,
 * so desktop/tablet and a closed sheet are unaffected by this function existing. */
export function phoneInitialDistance(width: number, height: number, coveredHeight: number, fovDeg = 40, fill = 0.6): number {
  const aspect = width / Math.max(height, 1);
  const offset = phoneViewOffset(width, height, coveredHeight);
  if (!offset) return initialDistance(aspect, fovDeg);
  const halfRad = (fovDeg * Math.PI) / 360;
  const h0 = 2 * Math.tan(halfRad);
  const w0 = aspect * h0;
  const hNew = h0 * (offset.viewHeight / offset.fullHeight);
  const wNew = w0 * (offset.viewWidth / offset.fullWidth);
  const theta = Math.atan((fill * Math.min(hNew, wNew)) / 2);
  return 1 / Math.sin(theta);
}

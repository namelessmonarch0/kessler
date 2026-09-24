/** Camera distance (Earth radii) at which the Earth spans ~60% of the smaller field of view. */
export function initialDistance(aspect: number, fovDeg = 40): number {
  const v = (fovDeg * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  return 1 / Math.sin((0.6 * Math.min(v, h)) / 2);
}

/** Screen radius (CSS px) of the unit-sphere Earth seen on-axis from `distance` Earth radii, for
 * a canvas `screenHeight` px tall with vertical field of view `fovDeg`. The silhouette's
 * half-angle is asin(1/d); its near-plane radius is tan of that, and the near plane spans
 * 2·tan(fov/2) over `screenHeight` px. Unaffected by sheetViewOffset (a pure shift). */
export function earthRadiusPx(distance: number, screenHeight: number, fovDeg = 40): number {
  const half = Math.tan((fovDeg * Math.PI) / 360);
  return (Math.tan(Math.asin(Math.min(1 / distance, 1))) / half) * (screenHeight / 2);
}

/** Fraction of the viewport height the bottom sheet may take at most — must match the sheet's
 * CSS `max-height` (60dvh, or 50dvh on short viewports; see MobileSheet.tsx). */
export function sheetMaxFraction(screenHeight: number): number {
  return screenHeight < 560 ? 0.5 : 0.6;
}

/** Height of the gap between the top bar's bottom edge and the tallest sheet the layout allows
 * (max-height fraction of the viewport + its 8px bottom margin). */
export function sheetWorstCaseHeight(screenHeight: number, topBarBottom: number): number {
  return Math.max(screenHeight - topBarBottom - (sheetMaxFraction(screenHeight) * screenHeight + 8), 0);
}

/** `THREE.PerspectiveCamera#setViewOffset` parameters for the bottom-sheet layout: a pure
 * vertical shift (full size == view size, so nothing is magnified or squashed) that moves the
 * on-axis Earth from the canvas centre (H/2) to the midpoint between the top bar's bottom edge
 * and the sheet's top edge. three.js does not clamp the view window to the full image, so a
 * negative or out-of-range offset is fine. Returns null for a zero-size canvas. */
export function sheetViewOffset(
  width: number,
  height: number,
  topBarBottom: number,
  sheetTop: number,
): { fullWidth: number; fullHeight: number; offsetX: number; offsetY: number; viewWidth: number; viewHeight: number } | null {
  if (width <= 0 || height <= 0) return null;
  const offsetY = height / 2 - (topBarBottom + sheetTop) / 2;
  return { fullWidth: width, fullHeight: height, offsetX: 0, offsetY, viewWidth: width, viewHeight: height };
}

/** Initial camera distance in the bottom-sheet layout, computed ONCE from a fixed worst case
 * (the tallest sheet the CSS allows, `sheetWorstCaseHeight`) so it never depends on when or
 * what the sheet first measures, and never needs re-fitting (which would fight the user's zoom).
 * Sizes the Earth to `fill` (90%) of the tighter of the gap's height and the screen width, so
 * with sheetViewOffset centring it in the gap it fits even under the tallest sheet. */
export function sheetInitialDistance(width: number, height: number, topBarBottom: number, fovDeg = 40, fill = 0.9): number {
  const box = Math.min(width, sheetWorstCaseHeight(height, topBarBottom));
  if (box <= 0 || height <= 0) return initialDistance(width / Math.max(height, 1), fovDeg);
  const half = Math.tan((fovDeg * Math.PI) / 360);
  // Invert earthRadiusPx: tan(theta) = r / (H/2) * tan(fov/2), d = 1 / sin(theta).
  const tanTheta = ((fill * box) / 2 / (height / 2)) * half;
  return 1 / Math.sin(Math.atan(tanTheta));
}

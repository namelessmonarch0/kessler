/** Camera distance (Earth radii) at which the Earth spans ~60% of the smaller field of view. */
export function initialDistance(aspect: number, fovDeg = 40): number {
  const v = (fovDeg * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  return 1 / Math.sin((0.6 * Math.min(v, h)) / 2);
}

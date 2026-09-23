const RAD = Math.PI / 180;

/** Subsolar point from UTC time (NOAA low-precision formulas, ~0.01° accuracy). */
export function subsolarPoint(date: Date): { latDeg: number; lonDeg: number } {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (280.46061837 + 360.98564736629 * d) * RAD;
  let lon = ra - gmst;
  lon = Math.atan2(Math.sin(lon), Math.cos(lon));
  return { latDeg: dec / RAD, lonDeg: lon / RAD };
}

/** Unit vector towards the Sun in scene coordinates (see ecefToScene). */
export function sunDirectionScene(date: Date): [number, number, number] {
  const { latDeg, lonDeg } = subsolarPoint(date);
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  const x = Math.cos(lat) * Math.cos(lon);
  const y = Math.cos(lat) * Math.sin(lon);
  const z = Math.sin(lat);
  return [x, z, -y];
}

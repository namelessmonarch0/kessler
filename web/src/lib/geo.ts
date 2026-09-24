import { EARTH_RADIUS_KM } from "@/lib/orbit";

export const WGS84 = { a: 6378.137, f: 1 / 298.257223563 } as const;
const E2 = WGS84.f * (2 - WGS84.f);
const RAD = Math.PI / 180;

export function geodeticToEcef(latDeg: number, lonDeg: number, altKm: number): [number, number, number] {
  const lat = latDeg * RAD, lon = lonDeg * RAD;
  const s = Math.sin(lat), c = Math.cos(lat);
  const n = WGS84.a / Math.sqrt(1 - E2 * s * s);
  return [(n + altKm) * c * Math.cos(lon), (n + altKm) * c * Math.sin(lon), (n * (1 - E2) + altKm) * s];
}

/** ECEF km -> WGS84 geodetic (Bowring-style iteration, stable at the poles). */
export function ecefToGeodetic(x: number, y: number, z: number): { latDeg: number; lonDeg: number; altKm: number } {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const s = Math.sin(lat), c = Math.cos(lat);
    const n = WGS84.a / Math.sqrt(1 - E2 * s * s);
    h = Math.abs(c) > 1e-9 ? p / c - n : Math.abs(z) - n * (1 - E2);
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  if (Math.abs(Math.cos(lat)) < 1e-6) {
    const n = WGS84.a / Math.sqrt(1 - E2);
    h = Math.abs(z) - n * (1 - E2);
  }
  return { latDeg: lat / RAD, lonDeg: lon / RAD, altKm: h };
}

/** Inverse of ecefToScene: scene (Earth radii, (x, z, -y)) -> ECEF km. */
export function sceneToEcef(sx: number, sy: number, sz: number): [number, number, number] {
  return [sx * EARTH_RADIUS_KM, -sz * EARTH_RADIUS_KM, sy * EARTH_RADIUS_KM];
}

export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dp = p2 - p1, dl = (lon2 - lon1) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

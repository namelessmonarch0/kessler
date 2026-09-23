import { eciToEcf, gstime, json2satrec, propagate, type SatRec } from "satellite.js";
import type { OrbitRecord } from "@/lib/snapshot";

export const EARTH_RADIUS_KM = 6371;

export function recordToSatrec(r: OrbitRecord): SatRec | null {
  try {
    const rec = json2satrec({
      OBJECT_NAME: String(r.noradId),
      OBJECT_ID: String(r.noradId),
      EPOCH: new Date(r.epochMs).toISOString().replace("Z", ""),
      MEAN_MOTION: r.meanMotion,
      ECCENTRICITY: r.eccentricity,
      INCLINATION: r.inclination,
      RA_OF_ASC_NODE: r.raan,
      ARG_OF_PERICENTER: r.argPericenter,
      MEAN_ANOMALY: r.meanAnomaly,
      NORAD_CAT_ID: r.noradId,
      ELEMENT_SET_NO: 999,
      BSTAR: r.bstar,
      MEAN_MOTION_DOT: r.meanMotionDot,
      MEAN_MOTION_DDOT: r.meanMotionDdot,
    });
    if (rec.error) return null;
    // Some invalid elements (e.g. eccentricity >= 1) only fail when propagated: reject them up front.
    const trial = propagate(rec, new Date(r.epochMs));
    return trial ? rec : null;
  } catch {
    return null;
  }
}

/** Earth-fixed km → scene units (Earth radius 1): scene = (x, z, -y) / R. */
export function ecefToScene(x: number, y: number, z: number, out: Float32Array, offset: number): void {
  out[offset] = x / EARTH_RADIUS_KM;
  out[offset + 1] = z / EARTH_RADIUS_KM;
  out[offset + 2] = -y / EARTH_RADIUS_KM;
}

export function propagateAll(satrecs: (SatRec | null)[], date: Date, out: Float32Array): number {
  const gmst = gstime(date);
  let ok = 0;
  for (let i = 0; i < satrecs.length; i++) {
    const rec = satrecs[i];
    const pv = rec ? propagate(rec, date) : null;
    const pos = pv ? pv.position : null;
    if (!pos || !Number.isFinite(pos.x)) {
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = Number.NaN;
      continue;
    }
    const ecf = eciToEcf(pos, gmst);
    ecefToScene(ecf.x, ecf.y, ecf.z, out, i * 3);
    ok++;
  }
  return ok;
}

import { sceneToEcef } from "../../src/lib/geo";
import { propagateAll, recordToSatrec } from "../../src/lib/orbit";
import type { OrbitRecord } from "../../src/lib/snapshot";

/** The site's own production pipeline for one record at one time: returns ECEF km via the scene frame. */
export function sitePosition(rec: OrbitRecord, timeMs: number): [number, number, number] | null {
  const out = new Float32Array(3);
  const ok = propagateAll([recordToSatrec(rec)], new Date(timeMs), out);
  return ok === 1 ? sceneToEcef(out[0], out[1], out[2]) : null;
}

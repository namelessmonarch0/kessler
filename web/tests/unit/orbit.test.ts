import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_KM, ecefToScene, propagateAll, recordToSatrec } from "@/lib/orbit";
import type { OrbitRecord } from "@/lib/snapshot";

const ISS: OrbitRecord = {
  noradId: 25544, owner: "ISS", type: "PAY", epochMs: Date.parse("2026-09-22T06:30:37.496Z"),
  meanMotion: 15.49224498, eccentricity: 0.00047657, inclination: 51.6312, raan: 179.6046,
  argPericenter: 167.6102, meanAnomaly: 192.5004, bstar: 0.0001364276, meanMotionDot: 0.00007132, meanMotionDdot: 0,
};

describe("ecefToScene", () => {
  it("maps lon 0 to +X, lon 90E to -Z and the north pole to +Y, in Earth radii", () => {
    const out = new Float32Array(9);
    ecefToScene(EARTH_RADIUS_KM, 0, 0, out, 0);
    ecefToScene(0, EARTH_RADIUS_KM, 0, out, 3);
    ecefToScene(0, 0, EARTH_RADIUS_KM, out, 6);
    expect(Array.from(out)).toEqual([1, 0, -0, 0, 0, -1, 0, 1, -0]);
  });
});

describe("propagateAll", () => {
  it("propagates the ISS to a ~420-440 km altitude at its epoch", () => {
    const out = new Float32Array(3);
    const ok = propagateAll([recordToSatrec(ISS)], new Date(ISS.epochMs), out);
    expect(ok).toBe(1);
    const altitudeKm = Math.hypot(out[0], out[1], out[2]) * EARTH_RADIUS_KM - EARTH_RADIUS_KM;
    expect(altitudeKm).toBeGreaterThan(420);
    expect(altitudeKm).toBeLessThan(440);
  });

  it("returns NaN for elements that fail to propagate", () => {
    const broken = recordToSatrec({ ...ISS, noradId: 1, eccentricity: 1.5 });
    const out = new Float32Array(6);
    const ok = propagateAll([broken, null], new Date(ISS.epochMs), out);
    expect(ok).toBe(0);
    expect(Array.from(out).every(Number.isNaN)).toBe(true);
  });
});

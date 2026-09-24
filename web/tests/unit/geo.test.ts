import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_KM, ecefToScene } from "@/lib/orbit";
import { ecefToGeodetic, geodeticToEcef, greatCircleKm, sceneToEcef, WGS84 } from "@/lib/geo";

describe("geodesy", () => {
  it("puts the equator/prime-meridian surface point at (a, 0, 0)", () => {
    const g = ecefToGeodetic(WGS84.a, 0, 0);
    expect(g.latDeg).toBeCloseTo(0, 9);
    expect(g.lonDeg).toBeCloseTo(0, 9);
    expect(g.altKm).toBeCloseTo(0, 6);
  });

  it("round-trips geodetic -> ECEF -> geodetic at many points, including 400 km and GEO altitude", () => {
    for (const [lat, lon, alt] of [[30.04, 31.24, 0], [-33.87, 151.21, 420], [51.5, -0.13, 35786], [-89.9, 10, 800], [89.9, -170, 550], [0, 179.99, 400]]) {
      const [x, y, z] = geodeticToEcef(lat, lon, alt);
      const g = ecefToGeodetic(x, y, z);
      expect(g.latDeg).toBeCloseTo(lat, 7);
      expect(g.lonDeg).toBeCloseTo(lon, 7);
      expect(g.altKm).toBeCloseTo(alt, 5);
    }
  });

  it("ecefToGeodetic is finite at the poles", () => {
    const b = WGS84.a * (1 - WGS84.f);
    const n = ecefToGeodetic(0, 0, b + 400);
    expect(n.latDeg).toBeCloseTo(90, 9);
    expect(n.altKm).toBeCloseTo(400, 6);
    expect(Number.isFinite(n.lonDeg)).toBe(true);
    const s = ecefToGeodetic(0, 0, -b);
    expect(s.latDeg).toBeCloseTo(-90, 9);
    expect(s.altKm).toBeCloseTo(0, 6);
  });

  it("sceneToEcef inverts ecefToScene", () => {
    const out = new Float32Array(3);
    ecefToScene(1234.5, -4321.25, 5000, out, 0);
    const [x, y, z] = sceneToEcef(out[0], out[1], out[2]);
    expect(x).toBeCloseTo(1234.5, 2);
    expect(y).toBeCloseTo(-4321.25, 2);
    expect(z).toBeCloseTo(5000, 2);
    expect(EARTH_RADIUS_KM).toBe(6371);
  });

  it("greatCircleKm: a quarter meridian and a known city pair", () => {
    expect(greatCircleKm(0, 0, 90, 0)).toBeCloseTo((Math.PI / 2) * 6371, 6);
    expect(greatCircleKm(51.5074, -0.1278, 40.7128, -74.006)).toBeGreaterThan(5560);
    expect(greatCircleKm(51.5074, -0.1278, 40.7128, -74.006)).toBeLessThan(5580);
  });

  it("greatCircleKm wraps across the antimeridian", () => {
    expect(greatCircleKm(0, 179.9, 0, -179.9)).toBeCloseTo(0.2 * (Math.PI / 180) * 6371, 6);
  });
});

import { describe, expect, it } from "vitest";
import { subsolarPoint, sunDirectionScene } from "@/lib/sun";

describe("subsolarPoint", () => {
  it("is near the equator and prime meridian at the September 2026 equinox noon", () => {
    const p = subsolarPoint(new Date("2026-09-22T12:00:00Z"));
    expect(p.latDeg).toBeCloseTo(0.2, 1);
    expect(p.lonDeg).toBeCloseTo(-1.83, 1);
  });
  it("is at the Tropic of Cancer at the June solstice", () => {
    expect(subsolarPoint(new Date("2026-06-21T12:00:00Z")).latDeg).toBeCloseTo(23.44, 1);
  });
});

describe("sunDirectionScene", () => {
  it("is a unit vector pointing at lon ~0 (+X) at equinox noon", () => {
    const [x, y, z] = sunDirectionScene(new Date("2026-09-22T12:00:00Z"));
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    expect(x).toBeGreaterThan(0.99);
  });
});

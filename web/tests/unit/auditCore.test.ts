import { describe, expect, it } from "vitest";
import { buildDailyResult, measure, sampleObjects } from "../../scripts/accuracy/audit";
import { TOLERANCES } from "../../scripts/accuracy/tolerances";
import type { OrbitRecord } from "@/lib/snapshot";

const rec = (id: number, type: OrbitRecord["type"], epochMs = Date.UTC(2026, 8, 24)): OrbitRecord => ({
  noradId: id, owner: "US", type, epochMs, meanMotion: 15, eccentricity: 0.001, inclination: 53, raan: 0,
  argPericenter: 0, meanAnomaly: 0, bstar: 0, meanMotionDot: 0, meanMotionDdot: 0,
});
const pop = [
  ...Array.from({ length: 600 }, (_, i) => rec(1000 + i, "PAY")),
  ...Array.from({ length: 300 }, (_, i) => rec(5000 + i, "DEB")),
  ...Array.from({ length: 60 }, (_, i) => rec(8000 + i, "R/B")),
  rec(25544, "PAY"),
];

describe("sampleObjects", () => {
  it("is deterministic per date, stratified, and always includes sentinels", () => {
    const a = sampleObjects(pop, "2026-09-24", 100, [25544, 999999]);
    const b = sampleObjects(pop, "2026-09-24", 100, [25544, 999999]);
    const c = sampleObjects(pop, "2026-09-25", 100, [25544, 999999]);
    expect(a.map((r) => r.noradId)).toEqual(b.map((r) => r.noradId));
    expect(a.map((r) => r.noradId)).not.toEqual(c.map((r) => r.noradId));
    expect(a.some((r) => r.noradId === 25544)).toBe(true);
    expect(a.length).toBe(100);
    const deb = a.filter((r) => r.type === "DEB").length, rb = a.filter((r) => r.type === "R/B").length;
    expect(deb).toBeGreaterThanOrEqual(25);
    expect(rb).toBeGreaterThanOrEqual(10);
  });
});

describe("measure", () => {
  it("measures ground and altitude difference", () => {
    const m = measure(rec(1, "PAY"), "LEO", "X", Date.UTC(2026, 8, 25), { latDeg: 10, lonDeg: 20, altKm: 500 }, { ok: true, latDeg: 10, lonDeg: 20.01, altKm: 500.4 });
    expect(m.ok).toBe(true);
    expect(m.groundKm!).toBeCloseTo(0.01 * (Math.PI / 180) * 6371 * Math.cos((10 * Math.PI) / 180), 3);
    expect(m.altDiffKm!).toBeCloseTo(0.4, 6);
    expect(m.ageDays).toBeCloseTo(1, 6);
  });
  it("measure skips objects that fail to propagate", () => {
    const m = measure(rec(1, "DEB"), "LEO", "X", 0, null, { ok: false, error: "sgp4 error 6" });
    expect(m.ok).toBe(false);
    expect(m.groundKm).toBeNull();
  });
});

describe("buildDailyResult", () => {
  const meta = { date: "2026-09-24", commit: "abc", generatedAt: "2026-09-24T06:00:00Z", timeMs: 0 };
  it("aggregates by type/regime, ages, and worst list; excludes failures from errors", () => {
    const ok = (id: number, type: OrbitRecord["type"], g: number, age: number) => ({ noradId: id, name: `N${id}`, type, regime: "LEO" as const, ageDays: age, groundKm: g, altDiffKm: 0.1, ok: true });
    const r = buildDailyResult(meta, [ok(1, "PAY", 0.2, 0.5), ok(2, "DEB", 0.9, 4), ok(3, "DEB", 0.1, 1), { noradId: 4, name: "N4", type: "R/B", regime: "LEO", ageDays: 1, groundKm: null, altDiffKm: null, ok: false, error: "x" }], null);
    expect(r.sampled).toBe(4);
    expect(r.failed).toBe(1);
    expect(r.byType.DEB.maxKm).toBeCloseTo(0.9);
    expect(r.worst[0].noradId).toBe(2);
    expect(r.age.staleShare).toBeCloseTo(1 / 3);
    expect(TOLERANCES.staleDays).toBe(3);
  });
  it("buildDailyResult with no ISS reference sets iss null", () => {
    expect(buildDailyResult(meta, [], null).iss).toBeNull();
  });
});

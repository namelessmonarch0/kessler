import { describe, expect, it } from "vitest";
import { createHandler, type WorkerOut } from "@/workers/propagate.worker";
import type { OrbitRecord } from "@/lib/snapshot";

const ISS: OrbitRecord = {
  noradId: 25544, owner: "ISS", type: "PAY", epochMs: Date.parse("2026-09-22T06:30:37.496Z"),
  meanMotion: 15.49224498, eccentricity: 0.00047657, inclination: 51.6312, raan: 179.6046,
  argPericenter: 167.6102, meanAnomaly: 192.5004, bstar: 0.0001364276, meanMotionDot: 0.00007132, meanMotionDdot: 0,
};

describe("propagate worker handler", () => {
  it("loads records, then answers ticks with transferable positions", () => {
    const sent: { msg: WorkerOut; transfer?: Transferable[] }[] = [];
    const handle = createHandler((msg, transfer) => sent.push({ msg, transfer }));
    handle({ kind: "load", records: [ISS, { ...ISS, noradId: 2, eccentricity: 2 }] });
    expect(sent[0].msg).toEqual({ kind: "loaded", count: 2, valid: 1 });

    handle({ kind: "tick", timeMs: ISS.epochMs, id: 7 });
    const out = sent[1].msg;
    expect(out.kind).toBe("positions");
    if (out.kind !== "positions") throw new Error("unreachable");
    expect(out.id).toBe(7);
    expect(out.positions.length).toBe(6);
    expect(Number.isFinite(out.positions[0])).toBe(true);
    expect(Number.isNaN(out.positions[3])).toBe(true);
    expect(sent[1].transfer?.[0]).toBe(out.positions.buffer);
  });

  it("answers a path request with one orbital period centred on the given time", () => {
    const sent: { msg: WorkerOut; transfer?: Transferable[] }[] = [];
    const handle = createHandler((msg, transfer) => sent.push({ msg, transfer }));
    handle({ kind: "load", records: [ISS] });
    handle({ kind: "path", id: 3, index: 0, centerMs: ISS.epochMs, steps: 181 });
    const out = sent[1].msg;
    if (out.kind !== "path") throw new Error(`expected path, got ${out.kind}`);
    expect(out.id).toBe(3);
    expect(out.positions.length).toBe(181 * 3);
    expect(Array.from(out.positions).every(Number.isFinite)).toBe(true);
    // The middle sample is the object's position at centerMs.
    handle({ kind: "tick", timeMs: ISS.epochMs, id: 9 });
    const tick = sent[2].msg;
    if (tick.kind !== "positions") throw new Error("expected positions");
    for (let k = 0; k < 3; k++) expect(out.positions[90 * 3 + k]).toBeCloseTo(tick.positions[k], 5);
    // LEO altitude throughout (scene units: Earth radius 1).
    for (let i = 0; i < 181; i++) {
      const r = Math.hypot(out.positions[i * 3], out.positions[i * 3 + 1], out.positions[i * 3 + 2]);
      expect(r).toBeGreaterThan(1.05);
      expect(r).toBeLessThan(1.08);
    }
    expect(sent[1].transfer?.[0]).toBe(out.positions.buffer);
  });

  it("answers a path request for an invalid object with an empty path", () => {
    const sent: WorkerOut[] = [];
    const handle = createHandler((msg) => sent.push(msg));
    handle({ kind: "load", records: [{ ...ISS, eccentricity: 2 }] });
    handle({ kind: "path", id: 1, index: 0, centerMs: ISS.epochMs, steps: 10 });
    expect(sent[1]).toEqual({ kind: "path", id: 1, positions: new Float32Array(0) });
  });

  it("ignores ticks before any load", () => {
    const sent: WorkerOut[] = [];
    createHandler((m) => sent.push(m))({ kind: "tick", timeMs: 0, id: 1 });
    expect(sent).toEqual([]);
  });
});

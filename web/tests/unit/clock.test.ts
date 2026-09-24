import { beforeEach, describe, expect, it } from "vitest";
import { simClock } from "@/lib/clock";

describe("simClock", () => {
  beforeEach(() => {
    simClock.reset(1_000_000);
  });

  it("tick syncs straight to the injected wall-clock time instead of accumulating a delta", () => {
    // A backgrounded tab (or a dropped/late rAF) can hand this a stale callback arriving well
    // after the previous one; the clock must track real time exactly, not drift from
    // accumulating elapsed deltas.
    const wallNow = 1_000_000 + 45_000; // 45s of real time passed, e.g. while the tab was hidden
    simClock.tick(wallNow);
    expect(simClock.now()).toBe(wallNow);
  });

  it("repeated ticks stay pinned to whatever wall-clock time is injected", () => {
    simClock.tick(2_000_000);
    expect(simClock.now()).toBe(2_000_000);
    simClock.tick(2_000_500);
    expect(simClock.now()).toBe(2_000_500);
  });

  it("defaults the wall-clock argument to the real Date.now() when omitted", () => {
    const before = Date.now();
    simClock.tick();
    const after = Date.now();
    expect(simClock.now()).toBeGreaterThanOrEqual(before);
    expect(simClock.now()).toBeLessThanOrEqual(after);
  });

  it("reset sets the clock to an explicit time, or the real Date.now() by default", () => {
    simClock.reset(5_000_000);
    expect(simClock.now()).toBe(5_000_000);
    const before = Date.now();
    simClock.reset();
    const after = Date.now();
    expect(simClock.now()).toBeGreaterThanOrEqual(before);
    expect(simClock.now()).toBeLessThanOrEqual(after);
  });
});

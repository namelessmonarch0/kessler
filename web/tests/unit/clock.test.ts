import { beforeEach, describe, expect, it } from "vitest";
import { simClock } from "@/lib/clock";

describe("simClock", () => {
  beforeEach(() => {
    simClock.reset(1_000_000);
    simClock.setScale(1);
  });

  it("at scale 1, tick syncs straight to the injected wall-clock time instead of accumulating dt", () => {
    // A backgrounded tab can deliver a huge or stale realDtMs on the next rAF; at Live speed the
    // clock must track real time exactly, not drift from accumulating (possibly capped) deltas.
    const wallNow = 1_000_000 + 45_000; // 45s of real time passed, e.g. while the tab was hidden
    simClock.tick(100, wallNow);
    expect(simClock.now()).toBe(wallNow);
  });

  it("at scale 1, repeated ticks stay pinned to whatever wall-clock time is injected", () => {
    simClock.tick(100, 2_000_000);
    expect(simClock.now()).toBe(2_000_000);
    simClock.tick(100, 2_000_500);
    expect(simClock.now()).toBe(2_000_500);
  });

  it("at a fast scale, tick still accumulates realDtMs * scale (unaffected by wall-clock time)", () => {
    simClock.setScale(4320);
    simClock.tick(100, 999_999_999); // wall-clock time must be ignored off Live
    expect(simClock.now()).toBe(1_000_000 + 100 * 4320);
  });

  it("defaults the wall-clock argument to the real Date.now() when omitted", () => {
    const before = Date.now();
    simClock.tick(50);
    const after = Date.now();
    expect(simClock.now()).toBeGreaterThanOrEqual(before);
    expect(simClock.now()).toBeLessThanOrEqual(after);
  });
});

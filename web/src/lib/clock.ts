/** Simulation clock shared by the globe (sun + propagation). Tracks real wall-clock time. */
export const simClock = {
  t: Date.now(),
  now(): number {
    return this.t;
  },
  /**
   * Pins the clock straight to `wallNow` instead of accumulating an elapsed delta: a
   * backgrounded tab (or a dropped/late rAF) can hand this a stale callback arriving long after
   * the previous one, and accumulating that gap would leave the globe/sun/readout minutes
   * behind real time even after the tab regains focus.
   */
  tick(wallNow: number = Date.now()): void {
    this.t = wallNow;
  },
  reset(to: number = Date.now()): void {
    this.t = to;
  },
};

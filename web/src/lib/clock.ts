/** Simulation clock shared by the globe (sun + propagation). Real time × scale. */
export const simClock = {
  t: Date.now(),
  scale: 1,
  now(): number {
    return this.t;
  },
  /**
   * At scale 1 ("Live"), pins the clock straight to `wallNow` instead of accumulating
   * `realDtMs * scale`: a backgrounded tab (or a dropped/late rAF) can hand this a stale or
   * huge `realDtMs`, and accumulating it would leave the globe/sun/readout minutes behind
   * real time even after the tab regains focus. Off Live, real time doesn't apply — only the
   * simulated delta does, so `wallNow` is ignored there.
   */
  tick(realDtMs: number, wallNow: number = Date.now()): void {
    this.t = this.scale === 1 ? wallNow : this.t + realDtMs * this.scale;
  },
  setScale(scale: number): void {
    this.scale = scale;
  },
  reset(to: number = Date.now()): void {
    this.t = to;
  },
};

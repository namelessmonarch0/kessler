/** Simulation clock shared by the globe (sun + propagation). Real time × scale. */
export const simClock = {
  t: Date.now(),
  scale: 1,
  now(): number {
    return this.t;
  },
  tick(realDtMs: number): void {
    this.t += realDtMs * this.scale;
  },
  setScale(scale: number): void {
    this.scale = scale;
  },
  reset(to: number = Date.now()): void {
    this.t = to;
  },
};

/** Weekly-review tolerances (see .superpowers/sdd/2026-09-24-position-accuracy/global-constraints.md). */
export const TOLERANCES = {
  /** Math-error ground distance, weekly max, km. */
  mathGroundKm: 1,
  /** ISS ground distance vs wheretheiss.at, weekly max, km. */
  issGroundKm: 25,
  /** ISS |Δalt| vs wheretheiss.at, weekly max, km. */
  issAltKm: 10,
  /** An object's elements are "stale" past this many days. */
  staleDays: 3,
  /** Mean share of sampled objects with stale elements, max. */
  staleShareMax: 0.05,
  /** Daily captures required per 7-day week. */
  minDaysPerWeek: 4,
} as const;

/** Weekly-review tolerances (documented in web/README.md, "Accuracy"). */
export const TOLERANCES = {
  /** Math-error ground distance, weekly max, km. */
  mathGroundKm: 1,
  /** ISS ground distance vs wheretheiss.at, weekly max, km. */
  issGroundKm: 25,
  /** ISS |Δalt| vs wheretheiss.at, weekly max, km. */
  issAltKm: 10,
  /** Age of the LEO snapshot (now − its header's generated_at) at capture, weekly max, hours. Ingest runs every 6 h. */
  snapshotAgeHoursMax: 12,
  /** Objects the site fails to propagate while the reference succeeds, as a share of sampled, weekly (daily) max. */
  siteFailureShareMax: 0.005,
  /** Daily captures required per 7-day week. */
  minDaysPerWeek: 4,
  /** Information only (not a check): an object's elements are "stale" past this many days. */
  staleDays: 3,
} as const;

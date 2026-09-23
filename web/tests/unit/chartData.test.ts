import { describe, expect, it } from "vitest";
import { chartTitle, crossoverYear, ownerLabel, visibleTypeSeries } from "@/lib/chartData";
import type { TimeseriesResponse } from "@/lib/types";

const TS: TimeseriesResponse = {
  metric: "in_orbit", group_by: "type", years: [2022, 2023, 2024, 2025],
  series: [
    { key: "DEB", values: [11375, 10692, 10533, 9994] },
    { key: "PAY", values: [8039, 10204, 11895, 15229] },
    { key: "UNK", values: [40, 45, 50, 52] },
    { key: "R/B", values: [981, 970, 975, 978] },
  ],
};

describe("chartData", () => {
  it("keeps PAY, DEB, R/B in a fixed order", () => {
    expect(visibleTypeSeries(TS).map((s) => s.key)).toEqual(["PAY", "DEB", "R/B"]);
  });
  it("finds the year payloads overtook debris", () => {
    expect(crossoverYear(TS)).toBe(2024);
    expect(chartTitle(TS)).toBe("Payloads overtook debris in 2024");
  });
  it("falls back to a neutral title without a crossover", () => {
    const flat: TimeseriesResponse = { ...TS, series: [{ key: "DEB", values: [5, 5, 5, 5] }, { key: "PAY", values: [1, 1, 1, 1] }] };
    expect(crossoverYear(flat)).toBeNull();
    expect(chartTitle(flat)).toBe("Objects in orbit by type");
  });
  it("labels owners", () => {
    const owners = [{ code: "US", name: "United States", flag_emoji: null, in_orbit: 1, total: 1 }];
    expect(ownerLabel("US", owners)).toBe("United States");
    expect(ownerLabel("_other", owners)).toBe("Other");
    expect(ownerLabel("POR", owners)).toBe("POR");
  });
});

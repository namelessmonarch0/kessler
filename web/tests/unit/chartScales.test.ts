import { describe, expect, it } from "vitest";
import { niceMax, yTicks } from "@/components/charts/scales";

describe("chart scales", () => {
  it("rounds the axis max up to a clean number", () => {
    expect(niceMax(15229)).toBe(20000);
    expect(niceMax(9994)).toBe(10000);
    expect(niceMax(2300)).toBe(2500);
    expect(niceMax(0)).toBe(1);
  });
  it("makes five evenly spaced ticks from zero", () => {
    expect(yTicks(20000)).toEqual([0, 5000, 10000, 15000, 20000]);
  });
});

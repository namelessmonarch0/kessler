import { describe, expect, it } from "vitest";
import { shortestAngle } from "@/components/globe/flyTo";

describe("shortestAngle", () => {
  it("goes the short way round the globe", () => {
    expect(shortestAngle(0.1, 0.3)).toBeCloseTo(0.2, 10);
    expect(shortestAngle(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6, 10);
    expect(shortestAngle(-3.0, 3.0)).toBeCloseTo(-(2 * Math.PI - 6), 10);
  });
});

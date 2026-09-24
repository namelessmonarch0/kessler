import { describe, expect, it } from "vitest";
import { initialDistance } from "@/lib/camera";

describe("initialDistance", () => {
  it("frames the Earth at ~60% of the vertical field on landscape screens", () => {
    // vfov 40° -> target 24° -> d = 1 / sin(12°)
    expect(initialDistance(16 / 9)).toBeCloseTo(1 / Math.sin((12 * Math.PI) / 180), 3);
  });
  it("uses the narrower horizontal field on portrait phones", () => {
    const hfov = 2 * Math.atan(Math.tan((20 * Math.PI) / 180) * 0.46);
    expect(initialDistance(0.46)).toBeCloseTo(1 / Math.sin((0.6 * hfov) / 2), 3);
  });
});

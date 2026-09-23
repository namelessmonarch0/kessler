import { describe, expect, it } from "vitest";
import { fmtDate, fmtInt, fmtKm } from "@/lib/format";

describe("format", () => {
  it("formats integers with thousands separators", () => {
    expect(fmtInt(28625)).toBe("28,625");
    expect(fmtInt(0)).toBe("0");
  });
  it("formats kilometres and missing values", () => {
    expect(fmtKm(422.4)).toBe("422 km");
    expect(fmtKm(null)).toBe("—");
  });
  it("formats ISO dates in UTC", () => {
    expect(fmtDate("1998-11-20")).toBe("20 Nov 1998");
    expect(fmtDate(null)).toBe("—");
  });
});

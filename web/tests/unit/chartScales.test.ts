import { describe, expect, it } from "vitest";
import { labelColumn, layoutAnnotations, niceMax, tooltipPosition, yearTicks, yTicks } from "@/components/charts/scales";

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

describe("layoutAnnotations", () => {
  const xOf = (year: number) => (year - 1957) * 10;

  it("moves an overlapping label to a new row instead of colliding", () => {
    const items = [
      { year: 2007, label: "Fengyun-1C ASAT test" },
      { year: 2019, label: "Starlink launches begin" },
    ];
    const result = layoutAnnotations(items, xOf, 0, 680);
    expect(result[0].row).toBe(0);
    expect(result[1].row).toBe(1);
  });

  it("switches to a start anchor when the end anchor would cross the left edge", () => {
    const items = [{ year: 1957, label: "Sputnik launched" }];
    const result = layoutAnnotations(items, xOf, 0, 680);
    expect(result[0].anchor).toBe("start");
  });

  it("keeps an end anchor with room to spare", () => {
    const items = [{ year: 2021, label: "Kosmos 1408 ASAT test" }];
    const result = layoutAnnotations(items, xOf, 0, 680);
    expect(result[0].anchor).toBe("end");
  });
});

describe("labelColumn", () => {
  it("reserves enough room for the longest label, capped at 38% of the width", () => {
    const { marginLeft, display } = labelColumn(["United States", "China"], 250);
    expect(marginLeft).toBe(95);
    expect(display[0]).toBe("United St…");
    expect(display[1]).toBe("China");
  });

  it("leaves short labels untouched when the column has room", () => {
    const { display } = labelColumn(["USA", "UK"], 400);
    expect(display).toEqual(["USA", "UK"]);
  });
});

describe("yearTicks", () => {
  it("always keeps the first and last year and drops close interior ticks", () => {
    const xOf = (year: number) => (year - 1957) * 10;
    const ticks = yearTicks(1957, 2025, xOf);
    expect(ticks[0]).toBe(1957);
    expect(ticks[ticks.length - 1]).toBe(2025);
    for (let i = 1; i < ticks.length; i++) {
      expect(xOf(ticks[i]) - xOf(ticks[i - 1])).toBeGreaterThanOrEqual(44);
    }
  });

  it("prefers keeping the last tick over a colliding interior one", () => {
    const xOf = (year: number) => (year - 1957) * 4; // narrow: 68yr * 4 = 272px
    const ticks = yearTicks(1957, 2025, xOf);
    expect(ticks[ticks.length - 1]).toBe(2025);
    expect(xOf(2025) - xOf(ticks[ticks.length - 2])).toBeGreaterThanOrEqual(44);
  });
});

describe("tooltipPosition", () => {
  it("flips to the left/up when the default position would overflow, and clamps to the edges", () => {
    const pos = tooltipPosition(780, 780, 800, 800, 200, 90);
    expect(pos.left).toBeLessThan(780);
    expect(pos.top).toBeLessThan(780);
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });

  it("keeps the default +14/+14 offset when there's room", () => {
    expect(tooltipPosition(10, 10, 800, 800, 200, 90)).toEqual({ left: 24, top: 24 });
  });
});

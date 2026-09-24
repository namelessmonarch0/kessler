import { describe, expect, it } from "vitest";
import { evaluateWeek, planIssueAction, renderMarkdown } from "../../scripts/accuracy/weekly";

const day = (date: string, over: Record<string, unknown> = {}) => JSON.stringify({
  date, commit: "abc", generatedAt: `${date}T06:00:00Z`, timeMs: Date.parse(`${date}T06:23:00Z`), sampled: 500, failed: 3,
  byType: { PAY: { n: 300, maxKm: 0.3, p95Km: 0.1 }, DEB: { n: 150, maxKm: 0.4, p95Km: 0.2 } },
  byRegime: { LEO: { n: 450, maxKm: 0.4, p95Km: 0.2 }, HIGH: { n: 50, maxKm: 0.2, p95Km: 0.1 } },
  age: { p50Days: 0.4, p95Days: 1.5, staleShare: 0.01 },
  iss: { groundKm: 4, altDiffKm: 1, theirs: { latDeg: 0, lonDeg: 0, altKm: 420, timestamp: 0 } },
  worst: [], ...over,
});
const week = (over: Record<string, Record<string, unknown>> = {}) =>
  ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"].map((d) => ({ date: d, raw: day(d, over[d]) as string | null }));

describe("evaluateWeek", () => {
  it("passes a healthy week", () => {
    const r = evaluateWeek(week());
    expect(r.pass).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it("fails when the math error exceeds 1 km on any day", () => {
    const r = evaluateWeek(week({ "2026-09-24": { byType: { DEB: { n: 150, maxKm: 1.7, p95Km: 0.3 } } } }));
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith("Math"))!.pass).toBe(false);
  });
  it("fails on ISS drift and on stale data", () => {
    expect(evaluateWeek(week({ "2026-09-22": { iss: { groundKm: 40, altDiffKm: 1, theirs: { latDeg: 0, lonDeg: 0, altKm: 420, timestamp: 0 } } } })).pass).toBe(false);
    expect(evaluateWeek(week(Object.fromEntries(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"].map((d) => [d, { age: { p50Days: 2, p95Days: 5, staleShare: 0.12 } }])))).pass).toBe(false);
  });
  it("evaluateWeek treats unparsable days as missing", () => {
    const days = week();
    days[0].raw = "{not json";
    days[1].raw = null;
    days[2].raw = JSON.stringify({ hello: "world" });
    const r = evaluateWeek(days);
    expect(r.missing).toEqual(["2026-09-21", "2026-09-22", "2026-09-23"]);
    expect(r.pass).toBe(true); // 4 of 7 present
    days[3].raw = null;
    expect(evaluateWeek(days).pass).toBe(false);
  });
  it("ignores ISS-less days for the ISS checks", () => {
    const r = evaluateWeek(week(Object.fromEntries(["2026-09-21", "2026-09-22"].map((d) => [d, { iss: null }]))));
    expect(r.pass).toBe(true);
  });
});

describe("planIssueAction / renderMarkdown", () => {
  const bad = evaluateWeek(week({ "2026-09-24": { byType: { DEB: { n: 150, maxKm: 1.7, p95Km: 0.3 } } } }));
  it("opens an issue when failing and none is open", () => {
    const a = planIssueAction(bad, []);
    expect(a.action).toBe("open");
    if (a.action === "open") expect(a.title).toBe(`Position accuracy out of tolerance — week of ${bad.weekOf}`);
  });
  it("planIssueAction comments when an accuracy issue is open", () => {
    const a = planIssueAction(bad, [42]);
    expect(a).toMatchObject({ action: "comment", issue: 42 });
  });
  it("does nothing on a passing week, and renders a table", () => {
    const good = evaluateWeek(week());
    expect(planIssueAction(good, [42])).toEqual({ action: "none" });
    const md = renderMarkdown(good, []);
    expect(md).toContain("| Check |");
    expect(md).toContain("PASS");
  });
});

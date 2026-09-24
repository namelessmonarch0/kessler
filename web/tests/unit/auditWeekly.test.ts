import { describe, expect, it } from "vitest";
import { evaluateWeek, planIssueAction, renderMarkdown } from "../../scripts/accuracy/weekly";

const day = (date: string, over: Record<string, unknown> = {}) => JSON.stringify({
  date, commit: "abc", generatedAt: `${date}T06:00:00Z`, timeMs: Date.parse(`${date}T06:23:00Z`), snapshotAgeHours: 0.4, sampled: 500, failed: 3,
  failures: { site: 0, reference: 3, both: 0 },
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
  it("fails on ISS drift", () => {
    expect(evaluateWeek(week({ "2026-09-22": { iss: { groundKm: 40, altDiffKm: 1, theirs: { latDeg: 0, lonDeg: 0, altKm: 420, timestamp: 0 } } } })).pass).toBe(false);
  });
  it("element age is information only: a high stale share does not fail the week", () => {
    const r = evaluateWeek(week(Object.fromEntries(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"].map((d) => [d, { age: { p50Days: 2, p95Days: 5, staleShare: 0.12 } }]))));
    expect(r.pass).toBe(true);
    expect(r.checks.some((c) => /stale/i.test(c.name))).toBe(false);
    expect(renderMarkdown(r, [])).toMatch(/Element age/);
  });
  it("fails when a snapshot was more than 12 h old at capture", () => {
    const ok = evaluateWeek(week({ "2026-09-23": { snapshotAgeHours: 11.9 } }));
    expect(ok.checks.find((c) => c.name.startsWith("Snapshot age"))!).toMatchObject({ value: 11.9, pass: true });
    const r = evaluateWeek(week({ "2026-09-23": { snapshotAgeHours: 13 } }));
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith("Snapshot age"))!).toMatchObject({ value: 13, limit: 12, pass: false });
  });
  it("fails the snapshot-age check when no present day recorded a snapshot age", () => {
    const r = evaluateWeek(week(Object.fromEntries(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"].map((d) => [d, { snapshotAgeHours: null }]))));
    expect(r.checks.find((c) => c.name.startsWith("Snapshot age"))!.pass).toBe(false);
  });
  it("fails when site-only failures exceed 0.5% of sampled on any day", () => {
    const at = (site: number) => evaluateWeek(week({ "2026-09-25": { failures: { site, reference: 0, both: 0 } } }));
    expect(at(2).checks.find((c) => c.name.startsWith("Site-only"))!.pass).toBe(true); // 0.4%
    const r = at(3); // 0.6%
    const c = r.checks.find((c) => c.name.startsWith("Site-only"))!;
    expect(c.value).toBeCloseTo(0.006, 9);
    expect(c.pass).toBe(false);
    expect(r.pass).toBe(false);
  });
  it("fails the math check when days are present but none has a measured object", () => {
    const r = evaluateWeek(week(Object.fromEntries(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"].map((d) => [d, { byType: {}, byRegime: {} }]))));
    const math = r.checks.find((c) => c.name.startsWith("Math"))!;
    expect(math.value).toBeNull();
    expect(math.pass).toBe(false);
    expect(r.pass).toBe(false);
  });
  it("does not count days before the first-ever capture as missing", () => {
    const days = week();
    for (const d of days.slice(0, 5)) d.raw = null; // captures began on 2026-09-26
    const r = evaluateWeek(days, { firstCapture: "2026-09-26" });
    expect(r.missing).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.checks.find((c) => c.name.startsWith("Daily captures"))!.detail).toBe("2 of 2");
    // ...but a gap after the first capture still counts, and without firstCapture every day counts
    days[6].raw = null;
    expect(evaluateWeek(days, { firstCapture: "2026-09-26" }).missing).toEqual(["2026-09-27"]);
    expect(evaluateWeek(days, { firstCapture: "2026-09-26" }).pass).toBe(false);
    expect(evaluateWeek(week().map((d, i) => (i < 5 ? { ...d, raw: null } : d))).pass).toBe(false);
  });
  it("ISS checks with no ISS data pass vacuously only with enough days from the first capture", () => {
    const days = week(Object.fromEntries(["2026-09-26", "2026-09-27"].map((d) => [d, { iss: null }])));
    for (const d of days.slice(0, 5)) d.raw = null;
    expect(evaluateWeek(days, { firstCapture: "2026-09-26" }).checks.find((c) => c.name.startsWith("ISS ground"))!.pass).toBe(true);
    days[6].raw = null;
    expect(evaluateWeek(days, { firstCapture: "2026-09-26" }).checks.find((c) => c.name.startsWith("ISS ground"))!.pass).toBe(false);
  });
  it("lists each object once in the worst list, at its worst", () => {
    const w = (id: number, g: number) => ({ noradId: id, name: `N${id}`, type: "DEB", regime: "LEO", ageDays: 1, groundKm: g, altDiffKm: 0, ok: true });
    const r = evaluateWeek(week({ "2026-09-21": { worst: [w(7, 0.5), w(8, 0.2)] }, "2026-09-22": { worst: [w(7, 0.9), w(9, 0.3)] } }));
    expect(r.worst.map((m) => [m.noradId, m.groundKm])).toEqual([[7, 0.9], [9, 0.3], [8, 0.2]]);
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
  it("treats a day missing byRegime, or with byType null, as missing rather than throwing", () => {
    const days = week();
    const noByRegime = JSON.parse(days[0].raw!);
    delete noByRegime.byRegime;
    days[0].raw = JSON.stringify(noByRegime);
    days[1].raw = day("2026-09-22", { byType: null });
    expect(() => evaluateWeek(days)).not.toThrow();
    const r = evaluateWeek(days);
    expect(r.missing).toEqual(["2026-09-21", "2026-09-22"]);
  });
  it("fails the ISS ground check when there are 0 ISS days and only 3 days present", () => {
    const days = week(Object.fromEntries(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"].map((d) => [d, { iss: null }])));
    days[0].raw = null;
    days[1].raw = null;
    days[2].raw = null;
    days[3].raw = null;
    const r = evaluateWeek(days);
    expect(r.present.length).toBe(3);
    const issCheck = r.checks.find((c) => c.name.startsWith("ISS ground"))!;
    expect(issCheck.value).toBeNull();
    expect(issCheck.pass).toBe(false);
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

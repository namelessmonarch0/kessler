import type { DailyResult, Measurement } from "./audit";
import { TOLERANCES } from "./tolerances";

export type Check = { name: string; value: number | null; limit: number; pass: boolean; detail: string };

export type WeeklyResult = {
  weekOf: string;
  present: DailyResult[];
  missing: string[];
  checks: Check[];
  pass: boolean;
  worst: Measurement[];
};

export type HistoryEntry = { weekOf: string; pass: boolean; mathMaxKm: number | null; issMaxKm: number | null };

/** Builds a week's `HistoryEntry` by looking up its checks by name, not position. */
export function historyEntryFor(result: WeeklyResult): HistoryEntry {
  return {
    weekOf: result.weekOf,
    pass: result.pass,
    mathMaxKm: result.checks.find((c) => c.name.startsWith("Math"))!.value,
    issMaxKm: result.checks.find((c) => c.name.startsWith("ISS ground"))!.value,
  };
}

type InputDay = { date: string; raw: string | null };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parses a day's raw JSON and validates it looks like a `DailyResult`, or returns null. */
function parseDay(raw: string | null): DailyResult | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const p = parsed;
  if (typeof p.date !== "string") return null;
  if (!isPlainObject(p.byType)) return null;
  if (!isPlainObject(p.byRegime)) return null;
  if (!isPlainObject(p.age) || typeof p.age.staleShare !== "number") return null;
  if (typeof p.sampled !== "number") return null;
  if (!isPlainObject(p.failures) || typeof p.failures.site !== "number") return null;
  if (p.snapshotAgeHours !== null && typeof p.snapshotAgeHours !== "number") return null;
  if (p.iss !== null && !isPlainObject(p.iss)) return null;
  return p as unknown as DailyResult;
}

function max(vals: number[]): number | null {
  return vals.length === 0 ? null : Math.max(...vals);
}

export type EvaluateOptions = {
  /** Date (YYYY-MM-DD) of the first-ever daily capture; days before it are outside the record, not missing. */
  firstCapture?: string;
  tol?: typeof TOLERANCES;
};

export function evaluateWeek(days: InputDay[], opts: EvaluateOptions = {}): WeeklyResult {
  const tol = opts.tol ?? TOLERANCES;
  const weekOf = days.length > 0 ? days[0].date : "";
  const eligible = opts.firstCapture ? days.filter((d) => d.date >= opts.firstCapture!) : days;
  const present: DailyResult[] = [];
  const missing: string[] = [];
  for (const d of eligible) {
    const parsed = parseDay(d.raw);
    if (parsed) present.push(parsed);
    else missing.push(d.date);
  }
  const daysPresent = present.length;
  /** Captures required: 4 of 7, or every eligible day when fewer than 4 fall after the first capture. */
  const daysRequired = Math.min(tol.minDaysPerWeek, eligible.length);

  const mathVals: number[] = [];
  for (const day of present) {
    for (const v of Object.values(day.byType)) mathVals.push(v.maxKm);
    for (const v of Object.values(day.byRegime)) mathVals.push(v.maxKm);
  }
  const mathMax = max(mathVals);

  const issDays = present.filter((d) => d.iss !== null);
  const issGroundMax = max(issDays.map((d) => d.iss!.groundKm));
  const issAltMax = max(issDays.map((d) => Math.abs(d.iss!.altDiffKm)));

  const snapshotAgeMax = max(present.flatMap((d) => (d.snapshotAgeHours === null ? [] : [d.snapshotAgeHours])));
  const siteShareMax = max(present.map((d) => (d.sampled > 0 ? d.failures.site / d.sampled : 0)));

  const checks: Check[] = [
    {
      name: "Math error (ground), weekly max",
      value: mathMax,
      limit: tol.mathGroundKm,
      pass: mathMax === null ? daysPresent === 0 : mathMax <= tol.mathGroundKm,
      detail: mathMax === null ? "no data" : `${mathMax.toFixed(3)} km`,
    },
    {
      name: "Site-only failures, share of sampled, weekly max",
      value: siteShareMax,
      limit: tol.siteFailureShareMax,
      pass: siteShareMax === null || siteShareMax <= tol.siteFailureShareMax,
      detail: siteShareMax === null ? "no data" : `${(siteShareMax * 100).toFixed(2)}%`,
    },
    {
      name: "ISS ground distance, weekly max",
      value: issGroundMax,
      limit: tol.issGroundKm,
      pass: issGroundMax === null ? daysPresent >= daysRequired : issGroundMax <= tol.issGroundKm,
      detail: issGroundMax === null ? "no ISS data" : `${issGroundMax.toFixed(3)} km`,
    },
    {
      name: "ISS altitude difference, weekly max",
      value: issAltMax,
      limit: tol.issAltKm,
      pass: issAltMax === null ? daysPresent >= daysRequired : issAltMax <= tol.issAltKm,
      detail: issAltMax === null ? "no ISS data" : `${issAltMax.toFixed(3)} km`,
    },
    {
      name: "Snapshot age at capture (h), weekly max",
      value: snapshotAgeMax,
      limit: tol.snapshotAgeHoursMax,
      pass: snapshotAgeMax === null ? daysPresent === 0 : snapshotAgeMax <= tol.snapshotAgeHoursMax,
      detail: snapshotAgeMax === null ? "no data" : `${snapshotAgeMax.toFixed(1)} h`,
    },
    {
      name: "Daily captures present",
      value: daysPresent,
      limit: daysRequired,
      pass: daysPresent >= daysRequired,
      detail: `${daysPresent} of ${eligible.length}`,
    },
  ];

  const worstById = new Map<number, Measurement>();
  for (const m of present.flatMap((d) => d.worst)) {
    const prev = worstById.get(m.noradId);
    if (!prev || (m.groundKm ?? -Infinity) > (prev.groundKm ?? -Infinity)) worstById.set(m.noradId, m);
  }
  const worst = [...worstById.values()]
    .sort((a, b) => (b.groundKm ?? -Infinity) - (a.groundKm ?? -Infinity))
    .slice(0, 10);

  return { weekOf, present, missing, checks, pass: checks.every((c) => c.pass), worst };
}

function fmtValue(c: Check): string {
  return c.value === null ? "—" : c.detail;
}

export function renderMarkdown(result: WeeklyResult, history: HistoryEntry[]): string {
  const lines: string[] = [];
  lines.push("# Position accuracy");
  lines.push("");
  lines.push(`## Week of ${result.weekOf} — ${result.pass ? "✅ PASS" : "❌ FAIL"}`);
  lines.push("");
  lines.push("| Check | Value | Limit | Result |");
  lines.push("|---|---|---|---|");
  for (const c of result.checks) {
    lines.push(`| ${c.name} | ${fmtValue(c)} | ${c.limit} | ${c.pass ? "PASS" : "FAIL"} |`);
  }
  lines.push("");
  lines.push(`Missing days: ${result.missing.length === 0 ? "none" : result.missing.join(", ")}`);
  lines.push("");
  lines.push("### Daily detail (information)");
  lines.push("");
  lines.push("| Date | Snapshot age (h) | Sampled | Failures site / reference / both | Element age p50 / p95 (d) | Element age > 3 d |");
  lines.push("|---|---|---|---|---|---|");
  for (const d of result.present) {
    const snap = d.snapshotAgeHours === null ? "—" : d.snapshotAgeHours.toFixed(1);
    const f = `${d.failures.site} / ${d.failures.reference} / ${d.failures.both}`;
    lines.push(`| ${d.date} | ${snap} | ${d.sampled} | ${f} | ${d.age.p50Days.toFixed(2)} / ${d.age.p95Days.toFixed(2)} | ${(d.age.staleShare * 100).toFixed(1)}% |`);
  }
  lines.push("");
  lines.push("Element age measures Space-Track's tracking cadence, not the site's freshness, so it is not a check.");
  lines.push("");
  lines.push("### Worst 10");
  if (result.worst.length === 0) {
    lines.push("");
    lines.push("None.");
  } else {
    lines.push("");
    lines.push("| NORAD ID | Name | Type | Regime | Ground (km) | Δalt (km) |");
    lines.push("|---|---|---|---|---|---|");
    for (const w of result.worst) {
      lines.push(
        `| ${w.noradId} | ${w.name} | ${w.type} | ${w.regime} | ${w.groundKm !== null ? w.groundKm.toFixed(3) : "—"} | ${w.altDiffKm !== null ? w.altDiffKm.toFixed(3) : "—"} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 12-week trend");
  lines.push("");
  lines.push("| Week of | Result | Math max (km) | ISS max (km) |");
  lines.push("|---|---|---|---|");
  const thisWeek = historyEntryFor(result);
  const trend = history
    .filter((h) => h.weekOf !== result.weekOf)
    .concat([thisWeek])
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf))
    .slice(-12);
  for (const h of trend) {
    lines.push(`| ${h.weekOf} | ${h.pass ? "PASS" : "FAIL"} | ${h.mathMaxKm !== null ? h.mathMaxKm.toFixed(3) : "—"} | ${h.issMaxKm !== null ? h.issMaxKm.toFixed(3) : "—"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function planIssueAction(
  result: WeeklyResult,
  openIssueNumbers: number[],
): { action: "none" } | { action: "open"; title: string; body: string } | { action: "comment"; issue: number; body: string } {
  if (result.pass) return { action: "none" };

  const title = `Position accuracy out of tolerance — week of ${result.weekOf}`;
  const failing = result.checks.filter((c) => !c.pass);
  const bodyLines = [
    `Week of ${result.weekOf} failed its accuracy checks.`,
    "",
    "Failing checks:",
    ...failing.map((c) => `- ${c.name}: ${fmtValue(c)} (limit ${c.limit})`),
  ];
  if (result.missing.length > 0) {
    bodyLines.push("", `Missing days: ${result.missing.join(", ")}`);
  }
  if (result.worst.length > 0) {
    bodyLines.push("", "Worst objects:");
    for (const w of result.worst.slice(0, 10)) {
      bodyLines.push(`- ${w.noradId} ${w.name} (${w.type}/${w.regime}): ground=${w.groundKm !== null ? w.groundKm.toFixed(3) : "—"}km altDiff=${w.altDiffKm !== null ? w.altDiffKm.toFixed(3) : "—"}km`);
    }
  }
  const body = bodyLines.join("\n");

  if (openIssueNumbers.length === 0) {
    return { action: "open", title, body };
  }
  return { action: "comment", issue: openIssueNumbers[0], body };
}

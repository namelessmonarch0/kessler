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
  if (p.iss !== null && !isPlainObject(p.iss)) return null;
  return p as unknown as DailyResult;
}

function max(vals: number[]): number | null {
  return vals.length === 0 ? null : Math.max(...vals);
}

export function evaluateWeek(days: InputDay[], tol = TOLERANCES): WeeklyResult {
  const weekOf = days.length > 0 ? days[0].date : "";
  const present: DailyResult[] = [];
  const missing: string[] = [];
  for (const d of days) {
    const parsed = parseDay(d.raw);
    if (parsed) present.push(parsed);
    else missing.push(d.date);
  }

  const mathVals: number[] = [];
  for (const day of present) {
    for (const v of Object.values(day.byType)) mathVals.push(v.maxKm);
    for (const v of Object.values(day.byRegime)) mathVals.push(v.maxKm);
  }
  const mathMax = max(mathVals);

  const issDays = present.filter((d) => d.iss !== null);
  const issGroundMax = issDays.length > 0 ? max(issDays.map((d) => d.iss!.groundKm)) : null;
  const issAltMax = issDays.length > 0 ? max(issDays.map((d) => Math.abs(d.iss!.altDiffKm))) : null;

  const staleShares = present.map((d) => d.age.staleShare);
  const staleMean = staleShares.length > 0 ? staleShares.reduce((a, b) => a + b, 0) / staleShares.length : null;

  const daysPresent = present.length;

  const checks: Check[] = [
    {
      name: "Math error (ground), weekly max",
      value: mathMax,
      limit: tol.mathGroundKm,
      pass: mathMax === null || mathMax <= tol.mathGroundKm,
      detail: mathMax === null ? "no data" : `${mathMax.toFixed(3)} km`,
    },
    {
      name: "ISS ground distance, weekly max",
      value: issGroundMax,
      limit: tol.issGroundKm,
      pass: issGroundMax === null ? daysPresent >= tol.minDaysPerWeek : issGroundMax <= tol.issGroundKm,
      detail: issGroundMax === null ? "no ISS data" : `${issGroundMax.toFixed(3)} km`,
    },
    {
      name: "ISS altitude difference, weekly max",
      value: issAltMax,
      limit: tol.issAltKm,
      pass: issAltMax === null ? daysPresent >= tol.minDaysPerWeek : issAltMax <= tol.issAltKm,
      detail: issAltMax === null ? "no ISS data" : `${issAltMax.toFixed(3)} km`,
    },
    {
      name: "Stale element share, weekly mean",
      value: staleMean,
      limit: tol.staleShareMax,
      pass: staleMean === null || staleMean <= tol.staleShareMax,
      detail: staleMean === null ? "no data" : `${(staleMean * 100).toFixed(1)}%`,
    },
    {
      name: "Daily captures present",
      value: daysPresent,
      limit: tol.minDaysPerWeek,
      pass: daysPresent >= tol.minDaysPerWeek,
      detail: `${daysPresent} of ${days.length}`,
    },
  ];

  const worst = present
    .flatMap((d) => d.worst)
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

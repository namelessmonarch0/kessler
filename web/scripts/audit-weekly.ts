import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateWeek, historyEntryFor, planIssueAction, renderMarkdown, type HistoryEntry } from "./accuracy/weekly";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      out[key] = value;
      i++;
    }
  }
  return out;
}

/** YYYY-MM-DD for `date` in UTC. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The last 7 calendar days ending yesterday UTC, oldest first. */
function lastSevenDays(now: Date): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days: string[] = [];
  for (let offset = 7; offset >= 1; offset--) {
    days.push(isoDate(new Date(todayUtc - offset * 86_400_000)));
  }
  return days;
}

function readDailyFile(dir: string, date: string): string | null {
  const path = `${dir}/${date}.json`;
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** The earliest YYYY-MM-DD.json in `dir` (the first-ever daily capture), or undefined if there is none. */
function firstCaptureIn(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort()[0];
}

function readHistory(path: string): HistoryEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir;
  const historyPath = args.history;
  const outMd = args["out-md"];
  const outPlan = args["out-plan"];
  const openIssues = (args["open-issues"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));

  if (!dir || !historyPath || !outMd || !outPlan) {
    console.error("Usage: audit-weekly.ts --dir <audit/daily> --history <audit/history.json> --out-md <AUDIT.md> --out-plan <plan.json> [--open-issues 1,2]");
    process.exitCode = 1;
    return;
  }

  const dates = lastSevenDays(new Date());
  const days = dates.map((date) => ({ date, raw: readDailyFile(dir, date) }));

  const result = evaluateWeek(days, { firstCapture: firstCaptureIn(dir) });

  const existingHistory = readHistory(historyPath);
  const priorHistory = existingHistory.filter((h) => h.weekOf !== result.weekOf);
  const thisWeek = historyEntryFor(result);
  const updatedHistory = [...priorHistory, thisWeek].sort((a, b) => a.weekOf.localeCompare(b.weekOf));

  const md = renderMarkdown(result, priorHistory);
  ensureDir(outMd);
  writeFileSync(outMd, md);

  ensureDir(historyPath);
  writeFileSync(historyPath, JSON.stringify(updatedHistory, null, 2));

  const plan = planIssueAction(result, openIssues);
  ensureDir(outPlan);
  writeFileSync(outPlan, JSON.stringify(plan, null, 2));

  console.error(`Week of ${result.weekOf}: ${result.pass ? "PASS" : "FAIL"} (${result.present.length}/${days.length} days present)`);
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

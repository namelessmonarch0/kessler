import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ecefToGeodetic, greatCircleKm } from "../src/lib/geo";
import { loadSnapshot, type OrbitRecord } from "../src/lib/snapshot";
import { buildDailyResult, measure, sampleObjects, type DailyResult, type Measurement, type Reference, type Regime } from "./accuracy/audit";
import { sitePosition } from "./accuracy/sitePosition";

const SITE_ORIGIN = "https://kessler.kudayyurter.dev";
const WTIA_URL = "https://api.wheretheiss.at/v1/satellites/25544";
const ISS_NORAD_ID = 25544;
const SAMPLE_SIZE = 500;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const SNAPSHOT_RETRIES = 2;
const WTIA_TIMEOUT_MS = 10_000;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const TOOLS_DIR = join(REPO_ROOT, "tools", "accuracy");
const PROPAGATE_SCRIPT = join(TOOLS_DIR, "propagate.py");

type WtiaResponse = { latitude: number; longitude: number; altitude: number; timestamp: number };
type NamesResponse = { generated_at: string | null; names: Record<string, string> };

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string, timeoutMs: number, retries: number): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchIss(): Promise<WtiaResponse | null> {
  try {
    const res = await fetchWithTimeout(WTIA_URL, WTIA_TIMEOUT_MS);
    if (!res.ok) return null;
    return (await res.json()) as WtiaResponse;
  } catch {
    return null;
  }
}

async function fetchGroup(group: "LEO" | "HIGH"): Promise<{ records: OrbitRecord[]; names: NamesResponse }> {
  const [snapRes, namesRes] = await Promise.all([
    fetchWithRetry(`${SITE_ORIGIN}/api/globe/snapshot?group=${group}`, SNAPSHOT_TIMEOUT_MS, SNAPSHOT_RETRIES),
    fetchWithRetry(`${SITE_ORIGIN}/api/globe/names?group=${group}`, SNAPSHOT_TIMEOUT_MS, SNAPSHOT_RETRIES),
  ]);
  const gz = new Uint8Array(await snapRes.arrayBuffer());
  const { records } = await loadSnapshot(gz);
  const names = (await namesRes.json()) as NamesResponse;
  return { records, names };
}

function commitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

function runPropagate(items: { record: OrbitRecord; timeMs: number }[]): Reference[] {
  if (items.length === 0) return [];
  const r = spawnSync("uv", ["run", "--project", TOOLS_DIR, "python", PROPAGATE_SCRIPT], {
    input: JSON.stringify({ items }),
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 256,
  });
  if (r.status !== 0) {
    throw new Error(`propagate.py failed (status ${r.status}): ${r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout) as { results: Reference[] };
  return parsed.results;
}

function oursFor(rec: OrbitRecord, timeMs: number): { latDeg: number; lonDeg: number; altKm: number } | null {
  const p = sitePosition(rec, timeMs);
  return p ? ecefToGeodetic(...p) : null;
}

function percentileTable(m: Record<string, { n: number; maxKm: number; p95Km: number }>): string {
  return Object.entries(m)
    .map(([k, v]) => `    ${k.padEnd(6)} n=${String(v.n).padStart(4)}  max=${v.maxKm.toFixed(4)}km  p95=${v.p95Km.toFixed(4)}km`)
    .join("\n");
}

function printTable(result: DailyResult): void {
  const lines: string[] = [];
  lines.push(`Position audit — ${result.date} (commit ${result.commit}, generated_at ${result.generatedAt ?? "unknown"})`);
  lines.push(`  sampled=${result.sampled} failed=${result.failed}`);
  lines.push("  by type:");
  lines.push(percentileTable(result.byType));
  lines.push("  by regime:");
  lines.push(percentileTable(result.byRegime));
  lines.push(
    `  age: p50=${result.age.p50Days.toFixed(2)}d p95=${result.age.p95Days.toFixed(2)}d staleShare=${(result.age.staleShare * 100).toFixed(1)}%`,
  );
  if (result.iss) {
    lines.push(
      `  ISS vs wheretheiss.at: ground=${result.iss.groundKm.toFixed(3)}km altDiff=${result.iss.altDiffKm.toFixed(3)}km ` +
        `(theirs lat=${result.iss.theirs.latDeg.toFixed(4)} lon=${result.iss.theirs.lonDeg.toFixed(4)} alt=${result.iss.theirs.altKm.toFixed(3)}km)`,
    );
  } else {
    lines.push("  ISS vs wheretheiss.at: unavailable");
  }
  lines.push("  worst 5:");
  for (const w of result.worst.slice(0, 5)) {
    lines.push(`    ${String(w.noradId).padStart(6)} ${w.name.padEnd(24)} ${w.type.padEnd(4)} ground=${w.groundKm!.toFixed(4)}km altDiff=${w.altDiffKm!.toFixed(4)}km age=${w.ageDays.toFixed(2)}d`);
  }
  console.error(lines.join("\n"));
}

async function main(): Promise<void> {
  const outIdx = process.argv.indexOf("--out");
  const outFile = outIdx >= 0 ? process.argv[outIdx + 1] : null;

  const wtia = await fetchIss();
  const timeMs = wtia ? wtia.timestamp * 1000 : Date.now();

  let leo: { records: OrbitRecord[]; names: NamesResponse };
  let high: { records: OrbitRecord[]; names: NamesResponse };
  try {
    [leo, high] = await Promise.all([fetchGroup("LEO"), fetchGroup("HIGH")]);
  } catch (err) {
    console.error(`Failed to fetch or decode globe snapshots: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const regimeById = new Map<number, Regime>();
  for (const r of leo.records) regimeById.set(r.noradId, "LEO");
  for (const r of high.records) regimeById.set(r.noradId, "HIGH");
  const nameById = new Map<string, string>([...Object.entries(leo.names.names), ...Object.entries(high.names.names)]);
  const generatedAt = leo.names.generated_at ?? high.names.generated_at ?? null;
  const allRecords = [...leo.records, ...high.records];

  const golden = JSON.parse(
    readFileSync(new URL("../tests/fixtures/accuracy/golden.json", import.meta.url), "utf-8"),
  ) as { objects: { record: { noradId: number } }[] };
  const sentinelIds = golden.objects.map((o) => o.record.noradId);
  if (!sentinelIds.includes(ISS_NORAD_ID)) sentinelIds.unshift(ISS_NORAD_ID);

  const today = new Date(timeMs).toISOString().slice(0, 10);
  const sampled = sampleObjects(allRecords, today, SAMPLE_SIZE, sentinelIds);

  const items = sampled.map((rec) => ({ record: rec, timeMs }));
  const refs = runPropagate(items);

  const measurements: Measurement[] = sampled.map((rec, i) => {
    const regime = regimeById.get(rec.noradId) ?? "LEO";
    const name = nameById.get(String(rec.noradId)) ?? String(rec.noradId);
    const ours = oursFor(rec, timeMs);
    return measure(rec, regime, name, timeMs, ours, refs[i] ?? { ok: false, error: "no reference result" });
  });

  let iss: DailyResult["iss"] = null;
  if (wtia) {
    const issRecord = allRecords.find((r) => r.noradId === ISS_NORAD_ID);
    const ours = issRecord ? oursFor(issRecord, timeMs) : null;
    if (ours) {
      iss = {
        groundKm: greatCircleKm(ours.latDeg, ours.lonDeg, wtia.latitude, wtia.longitude),
        altDiffKm: wtia.altitude - ours.altKm,
        theirs: { latDeg: wtia.latitude, lonDeg: wtia.longitude, altKm: wtia.altitude, timestamp: wtia.timestamp },
      };
    }
  }

  const commit = commitSha();
  const result = buildDailyResult({ date: today, commit, generatedAt, timeMs }, measurements, iss);

  printTable(result);

  const json = JSON.stringify(result, null, 2);
  if (outFile) {
    writeFileSync(outFile, json);
    console.error(`Wrote ${outFile}`);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

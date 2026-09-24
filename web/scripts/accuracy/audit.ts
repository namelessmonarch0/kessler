import { greatCircleKm } from "../../src/lib/geo";
import type { OrbitRecord } from "../../src/lib/snapshot";
import type { ObjectType } from "../../src/lib/types";
import { TOLERANCES } from "./tolerances";

export type Regime = "LEO" | "HIGH";

export type Measurement = {
  noradId: number;
  name: string;
  type: ObjectType;
  regime: Regime;
  ageDays: number;
  groundKm: number | null;
  altDiffKm: number | null;
  ok: boolean;
  error?: string;
};

export type Reference = { ok: boolean; latDeg?: number; lonDeg?: number; altKm?: number; error?: string };

export type DailyResult = {
  date: string;
  commit: string;
  generatedAt: string | null;
  timeMs: number;
  sampled: number;
  failed: number;
  byType: Record<string, { n: number; maxKm: number; p95Km: number }>;
  byRegime: Record<string, { n: number; maxKm: number; p95Km: number }>;
  age: { p50Days: number; p95Days: number; staleShare: number };
  iss: { groundKm: number; altDiffKm: number; theirs: { latDeg: number; lonDeg: number; altKm: number; timestamp: number } } | null;
  worst: Measurement[];
};

/** mulberry32: small, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash, used to seed the PRNG from an ISO date. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function shuffle<T>(arr: readonly T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Deterministic (per dateIso), stratified-by-type sample of `n` records, always including the
 * sentinel ids that exist in `records`. See global-constraints and task-6-brief for the algorithm.
 */
export function sampleObjects(records: OrbitRecord[], dateIso: string, n: number, sentinels: number[]): OrbitRecord[] {
  const rand = mulberry32(hashSeed(dateIso));
  const byId = new Map(records.map((r) => [r.noradId, r]));
  const sentinelRecords = sentinels
    .map((id) => byId.get(id))
    .filter((r): r is OrbitRecord => r !== undefined);
  const sentinelIds = new Set(sentinelRecords.map((r) => r.noradId));

  const pool = records.filter((r) => !sentinelIds.has(r.noradId));
  const byType = new Map<ObjectType, OrbitRecord[]>();
  for (const r of pool) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type)!.push(r);
  }
  const types = [...byType.keys()];
  const totalPop = records.length;
  const remaining = Math.max(0, n - sentinelRecords.length);

  const allocated = new Map<ObjectType, number>();
  for (const t of types) {
    const poolSize = byType.get(t)!.length;
    const popT = poolSize + sentinelRecords.filter((r) => r.type === t).length;
    const raw = totalPop > 0 ? Math.round((remaining * popT) / totalPop) : 0;
    const floor = Math.min(10, popT);
    allocated.set(t, Math.min(poolSize, Math.max(raw, floor)));
  }

  let diff = [...allocated.values()].reduce((a, b) => a + b, 0) - remaining;
  let guard = 0;
  while (diff !== 0 && guard++ < 100000) {
    let target: ObjectType | null = null;
    let best = diff > 0 ? -Infinity : Infinity;
    for (const t of types) {
      const v = allocated.get(t)!;
      if (diff > 0 && v > 0 && v > best) { best = v; target = t; }
      if (diff < 0 && v < byType.get(t)!.length && v < best) { best = v; target = t; }
    }
    if (!target) break;
    allocated.set(target, allocated.get(target)! + (diff > 0 ? -1 : 1));
    diff += diff > 0 ? -1 : 1;
  }

  const picked: OrbitRecord[] = [...sentinelRecords];
  for (const t of types) {
    const shuffled = shuffle(byType.get(t)!, rand);
    picked.push(...shuffled.slice(0, allocated.get(t)!));
  }
  return picked;
}

/** Compares the site's own position (`ours`) against a reference (`ref`); either side failing yields ok: false. */
export function measure(
  rec: OrbitRecord,
  regime: Regime,
  name: string,
  timeMs: number,
  ours: { latDeg: number; lonDeg: number; altKm: number } | null,
  ref: Reference,
): Measurement {
  const ageDays = (timeMs - rec.epochMs) / 86_400_000;
  const base = { noradId: rec.noradId, name, type: rec.type, regime, ageDays };
  if (!ours || !ref.ok || ref.latDeg === undefined || ref.lonDeg === undefined || ref.altKm === undefined) {
    return { ...base, groundKm: null, altDiffKm: null, ok: false, error: ref.error };
  }
  const groundKm = greatCircleKm(ours.latDeg, ours.lonDeg, ref.latDeg, ref.lonDeg);
  const altDiffKm = ref.altKm - ours.altKm;
  return { ...base, groundKm, altDiffKm, ok: true };
}

/** Nearest-rank percentile over an ascending-sorted array. */
function nearestRank(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil((p / 100) * sortedAsc.length)));
  return sortedAsc[rank - 1];
}

function summarize(vals: number[]): { n: number; maxKm: number; p95Km: number } {
  const sorted = [...vals].sort((a, b) => a - b);
  return { n: sorted.length, maxKm: sorted[sorted.length - 1], p95Km: nearestRank(sorted, 95) };
}

export function buildDailyResult(
  meta: { date: string; commit: string; generatedAt: string | null; timeMs: number },
  ms: Measurement[],
  iss: DailyResult["iss"],
): DailyResult {
  const ok = ms.filter((m) => m.ok);
  const failed = ms.length - ok.length;

  const byTypeGroups = new Map<string, number[]>();
  const byRegimeGroups = new Map<string, number[]>();
  for (const m of ok) {
    if (!byTypeGroups.has(m.type)) byTypeGroups.set(m.type, []);
    byTypeGroups.get(m.type)!.push(m.groundKm!);
    if (!byRegimeGroups.has(m.regime)) byRegimeGroups.set(m.regime, []);
    byRegimeGroups.get(m.regime)!.push(m.groundKm!);
  }
  const byType: DailyResult["byType"] = {};
  for (const [k, vals] of byTypeGroups) byType[k] = summarize(vals);
  const byRegime: DailyResult["byRegime"] = {};
  for (const [k, vals] of byRegimeGroups) byRegime[k] = summarize(vals);

  const ages = ok.map((m) => m.ageDays).sort((a, b) => a - b);
  const staleShare = ages.length > 0 ? ages.filter((a) => a > TOLERANCES.staleDays).length / ages.length : 0;
  const age = { p50Days: nearestRank(ages, 50), p95Days: nearestRank(ages, 95), staleShare };

  const worst = [...ok].sort((a, b) => b.groundKm! - a.groundKm!).slice(0, 10);

  return { ...meta, sampled: ms.length, failed, byType, byRegime, age, iss, worst };
}

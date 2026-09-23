import type { ObjectType, OwnerSummary, TimeseriesResponse } from "@/lib/types";

export const ANNOTATIONS: { year: number; label: string; row: 0 | 1 }[] = [
  { year: 2007, label: "Fengyun-1C ASAT test", row: 0 },
  { year: 2009, label: "Iridium–Cosmos collision", row: 1 },
  { year: 2019, label: "Starlink launches begin", row: 0 },
  { year: 2021, label: "Kosmos 1408 ASAT test", row: 1 },
];

const SHOWN: ObjectType[] = ["PAY", "DEB", "R/B"];

export function visibleTypeSeries(ts: TimeseriesResponse): { key: ObjectType; values: number[] }[] {
  return SHOWN.flatMap((key) => {
    const s = ts.series.find((x) => x.key === key);
    return s ? [{ key, values: s.values }] : [];
  });
}

export function crossoverYear(ts: TimeseriesResponse): number | null {
  const pay = ts.series.find((s) => s.key === "PAY")?.values;
  const deb = ts.series.find((s) => s.key === "DEB")?.values;
  if (!pay || !deb) return null;
  let debrisLed = false;
  for (let i = 0; i < ts.years.length; i++) {
    if (deb[i] > pay[i]) debrisLed = true;
    else if (debrisLed && pay[i] > deb[i]) return ts.years[i];
  }
  return null;
}

export function chartTitle(ts: TimeseriesResponse): string {
  const year = crossoverYear(ts);
  return year ? `Payloads overtook debris in ${year}` : "Objects in orbit by type";
}

export function ownerLabel(key: string, owners: OwnerSummary[]): string {
  if (key === "_other") return "Other";
  return owners.find((o) => o.code === key)?.name ?? key;
}

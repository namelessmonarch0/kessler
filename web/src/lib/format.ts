const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function fmtInt(n: number): string {
  return INT.format(n);
}

export function fmtKm(n: number | null): string {
  return n === null ? "—" : `${INT.format(n)} km`;
}

export function fmtDate(iso: string | null): string {
  return iso ? DATE.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—";
}

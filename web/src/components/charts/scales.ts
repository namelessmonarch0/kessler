export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= max) return m * exp;
  return 10 * exp;
}

export function yTicks(max: number): number[] {
  return [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
}

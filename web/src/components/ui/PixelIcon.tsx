const ICONS = {
  sat: ["........", "##....##", "##.##.##", "###..###", "##.##.##", "##....##", "...##...", "..####.."],
  deb: ["........", "..#.....", "......#.", "...##...", "#..##...", ".......#", ".#...#..", "........"],
  rb: ["...##...", "..####..", "..####..", "..####..", "..####..", ".######.", ".#.##.#.", "...##..."],
  chat: ["########", "#......#", "#.#.#..#", "#......#", "########", "..#.....", ".#......", "........"],
} as const;

export type PixelIconName = keyof typeof ICONS;

export function PixelIcon({ name, size = 12, color = "currentColor" }: { name: PixelIconName; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
      {ICONS[name].flatMap((row, y) =>
        [...row].map((c, x) => (c === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} /> : null)),
      )}
    </svg>
  );
}

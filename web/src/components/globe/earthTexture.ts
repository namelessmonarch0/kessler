import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";

export const PALETTE = { ocean: "#2f6fd6", land: "#7fd06b", coast: "#0d1b2e" } as const;

const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const RAD = Math.PI / 180;

/** Geocentric latitude (degrees) of a WGS84 geodetic latitude on the surface: ψ = atan((1 − e²)·tan φ). */
export function geocentricLatDeg(latDeg: number): number {
  if (Math.abs(latDeg) >= 90) return latDeg; // tan(±90°) is not finite; the poles map to themselves
  return Math.atan((1 - WGS84_E2) * Math.tan(latDeg * RAD)) / RAD;
}

/** Equirectangular texel for a geodetic lon/lat (land data is WGS84). The Earth mesh is a sphere and objects are
 * placed along their geocentric direction, so each point is drawn at its geocentric latitude — where that
 * direction meets the sphere — not at its geodetic latitude (up to ~0.19° / ~20 km apart at 45°). */
export function lonLatToTexel(lon: number, lat: number, w: number, h: number): [number, number] {
  return [((lon + 180) / 360) * w, ((90 - geocentricLatDeg(lat)) / 180) * h];
}

/** A ring whose longitudes wind a full turn circles a pole (Antarctica's coast does): it never crosses back over
 * the antimeridian, so it cannot be split there and must be closed through the pole instead. Returns its texel
 * points with x unwrapped (continuous, running past the texture edge) and the pole's row, or null otherwise. */
function polarRing(ring: [number, number][], w: number, h: number): { pts: [number, number][]; poleY: number } | null {
  let turn = 0;
  for (let i = 1; i < ring.length; i++) turn += ((ring[i][0] - ring[i - 1][0] + 540) % 360) - 180;
  if (Math.abs(turn) < 180) return null;
  let x = 0;
  const pts = ring.map(([lon, lat], i): [number, number] => {
    x = i === 0 ? lonLatToTexel(lon, lat, w, h)[0] : x + ((((lon - ring[i - 1][0] + 540) % 360) - 180) / 360) * w;
    return [x, lonLatToTexel(lon, lat, w, h)[1]];
  });
  const meanLat = ring.reduce((sum, [, lat]) => sum + lat, 0) / ring.length;
  return { pts, poleY: meanLat < 0 ? h : 0 };
}

/** The same polyline shifted a texture width either way, so an unwrapped ring also covers the edge it ran past. */
const wrapCopies = (pts: [number, number][], w: number): [number, number][][] =>
  [-w, 0, w].map((dx) => pts.map(([x, y]): [number, number] => [x + dx, y]));

/** A ring lying entirely within 0.1° of a pole (the land data has one at 89.999° S) is a seam artifact with no
 * visible area; closing it through the pole would only stroke a coastline around the pole. */
const isPolarSliver = (ring: [number, number][]) => ring.every(([, lat]) => Math.abs(lat) > 89.9);

/** Converts a lon/lat ring to closed texel polygons (for filling). A ring that crosses the antimeridian is split
 * into a new segment wherever consecutive points jump more than half the texture width; a ring that circles a
 * pole is closed along the pole's row (drawn once per texture-width shift so it spans the whole texture). */
export function ringSegments(ring: [number, number][], w: number, h: number): [number, number][][] {
  if (isPolarSliver(ring)) return [];
  const polar = polarRing(ring, w, h);
  if (polar) {
    const { pts, poleY } = polar;
    return wrapCopies([...pts, [pts[pts.length - 1][0], poleY], [pts[0][0], poleY]], w);
  }
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  let prevX: number | null = null;
  for (const [lon, lat] of ring) {
    const p = lonLatToTexel(lon, lat, w, h);
    if (prevX !== null && Math.abs(p[0] - prevX) > w / 2) {
      segments.push(current);
      current = [];
    }
    current.push(p);
    prevX = p[0];
  }
  if (current.length) segments.push(current);
  return segments;
}

/** The coastline to stroke for a ring: its fill segments, except that a polar ring's closing edges (down the
 * texture edge and along the pole row) are not coast, so it is stroked as open polylines. */
function ringCoast(ring: [number, number][], w: number, h: number): { line: [number, number][]; closed: boolean }[] {
  if (isPolarSliver(ring)) return [];
  const polar = polarRing(ring, w, h);
  if (polar) return wrapCopies(polar.pts, w).map((line) => ({ line, closed: false }));
  return ringSegments(ring, w, h).map((line) => ({ line, closed: true }));
}

export function drawEarthTexture(
  ctx: CanvasRenderingContext2D,
  land: FeatureCollection | null,
  w: number,
  h: number,
): void {
  ctx.fillStyle = PALETTE.ocean;
  ctx.fillRect(0, 0, w, h);
  if (!land) return;
  const rings: [number, number][][] = [];
  for (const feature of land.features) {
    const g = feature.geometry as Polygon | MultiPolygon;
    const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const polygon of polygons) for (const ring of polygon) rings.push(ring as [number, number][]);
  }
  ctx.beginPath();
  for (const ring of rings) {
    for (const seg of ringSegments(ring, w, h)) {
      seg.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
    }
  }
  ctx.fillStyle = PALETTE.land;
  ctx.fill("evenodd");
  ctx.beginPath();
  for (const ring of rings) {
    for (const { line, closed } of ringCoast(ring, w, h)) {
      line.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      if (closed) ctx.closePath();
    }
  }
  ctx.lineWidth = Math.max(1.5, w / 1400);
  ctx.lineJoin = "round";
  ctx.strokeStyle = PALETTE.coast;
  ctx.stroke();
}

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

/** Converts a lon/lat ring to texel segments, starting a new segment when consecutive points
 * jump more than half the texture width (the ring crosses the antimeridian). */
export function ringSegments(ring: [number, number][], w: number, h: number): [number, number][][] {
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

export function drawEarthTexture(
  ctx: CanvasRenderingContext2D,
  land: FeatureCollection | null,
  w: number,
  h: number,
): void {
  ctx.fillStyle = PALETTE.ocean;
  ctx.fillRect(0, 0, w, h);
  if (!land) return;
  ctx.beginPath();
  for (const feature of land.features) {
    const g = feature.geometry as Polygon | MultiPolygon;
    const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (const seg of ringSegments(ring as [number, number][], w, h)) {
          seg.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
          ctx.closePath();
        }
      }
    }
  }
  ctx.fillStyle = PALETTE.land;
  ctx.fill("evenodd");
  ctx.lineWidth = Math.max(1.5, w / 1400);
  ctx.lineJoin = "round";
  ctx.strokeStyle = PALETTE.coast;
  ctx.stroke();
}

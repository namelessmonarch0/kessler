import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { lonLatToTexel } from "@/components/globe/earthTexture";

/** Ring segmentation at antimeridian, matching drawEarthTexture logic.
 * Returns segments in texel space [x, y] where x = lon + 180, y = 90 - lat. */
function ringSegments(ring: number[][], w: number, h: number): [number, number][][] {
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

/** Even-odd over all rings with antimeridian segmentation — the same fill rule drawEarthTexture uses.
 * Rings that cross the antimeridian are split into segments; each segment is treated as a closed polygon. */
export function isLand(lon: number, lat: number, land: FeatureCollection): boolean {
  let inside = false;
  const [tx, ty] = lonLatToTexel(lon, lat, 360, 180);

  for (const f of land.features) {
    const g = f.geometry as Polygon | MultiPolygon;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      for (const ring of poly) {
        const segments = ringSegments(ring as number[][], 360, 180);
        for (const segment of segments) {
          // Point-in-polygon test on the segment (treated as closed)
          let segmentInside = false;
          for (let i = 0, j = segment.length - 1; i < segment.length; j = i++) {
            const [xi, yi] = segment[i], [xj, yj] = segment[j];
            if (yi > ty !== yj > ty && tx < ((xj - xi) * (ty - yi)) / (yj - yi) + xi) segmentInside = !segmentInside;
          }
          if (segmentInside) inside = !inside;
        }
      }
    }
  }
  return inside;
}

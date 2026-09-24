import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { lonLatToTexel, ringSegments } from "@/components/globe/earthTexture";

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
        const segments = ringSegments(ring as [number, number][], 360, 180);
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

import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";

function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd over all rings — the same fill rule drawEarthTexture uses. */
export function isLand(lon: number, lat: number, land: FeatureCollection): boolean {
  let inside = false;
  for (const f of land.features) {
    const g = f.geometry as Polygon | MultiPolygon;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const poly of polys) for (const ring of poly) if (inRing(lon, lat, ring)) inside = !inside;
  }
  return inside;
}

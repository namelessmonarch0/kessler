import { readFileSync } from "node:fs";
import type { FeatureCollection } from "geojson";
import * as THREE from "three";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import { describe, expect, it } from "vitest";
import { createEarthTexture, EARTH_RADIUS, EARTH_SEGMENTS } from "@/components/globe/Earth";
import { lonLatToTexel } from "@/components/globe/earthTexture";
import { geodeticToEcef } from "@/lib/geo";
import { isLand } from "@/lib/landMask";
import { ecefToScene } from "@/lib/orbit";

const topo = JSON.parse(readFileSync(new URL("../../public/geo/land-50m.json", import.meta.url), "utf8")) as Topology;
const land = feature(topo, topo.objects.land) as unknown as FeatureCollection;

const LAND = { Cairo: [31.24, 30.04], Sahara: [13, 23], Denver: [-104.99, 39.74], Bordeaux: [-0.58, 44.84], "Buenos Aires": [-58.38, -34.6], Beijing: [116.4, 39.9], Sydney: [151.0, -33.8], Chukotka: [175.0, 66.0] };
const OCEAN = { "mid-Pacific": [-150, 0], "South Atlantic": [-15, -30], "North Atlantic": [-40, 45], "Indian Ocean": [80, -20], "Bering Sea": [-178.0, 57.0] };

/** UV tolerance, degrees of great-circle arc: the residual of linear UV interpolation across the 128×96
 * sphere's flat triangles (≤ 0.009° in latitude; in longitude it grows toward the poles in degrees of
 * longitude but stays ≤ ~0.02° of arc, so longitude differences are scaled by cos(latitude)). */
const UV_TOL_DEG = 0.02;

const mesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, ...EARTH_SEGMENTS), new THREE.MeshBasicMaterial());

/** Where on the actual Earth mesh (Earth.tsx's sphere args) a geodetic lat/lon lands: the object pipeline's
 * direction (geodeticToEcef → ecefToScene), a ray from outside toward the centre, and the interpolated UV. */
function meshUv(lon: number, lat: number): THREE.Vector2 {
  const [x, y, z] = geodeticToEcef(lat, lon, 0);
  const s = new Float32Array(3);
  ecefToScene(x, y, z, s, 0);
  const dir = new THREE.Vector3(s[0], s[1], s[2]).normalize();
  const ray = new THREE.Raycaster(dir.clone().multiplyScalar(3), dir.clone().negate());
  return ray.intersectObject(mesh)[0].uv!;
}

/** Geocentric latitude (degrees) of a geodetic surface point: the angle of its ECEF direction. */
function geocentricLat(lon: number, lat: number): number {
  const [x, y, z] = geodeticToEcef(lat, lon, 0);
  return (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
}

describe("T6 globe alignment", () => {
  it("the texture is uploaded with flipY (canvas row 0, north, at v = 1)", () => {
    const tex = createEarthTexture({ width: 8, height: 4 } as HTMLCanvasElement);
    expect(tex.flipY).toBe(true);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  for (const [name, [lon, lat]] of Object.entries({ ...LAND, ...OCEAN })) {
    it(`${name}: the mesh point for its lat/lon samples the texel drawn for that lat/lon`, () => {
      const uv = meshUv(lon, lat);
      const texLon = uv.x * 360 - 180;
      const texLat = uv.y * 180 - 90; // flipY: canvas row 0 (north) is v = 1
      // The mesh is a sphere, so the hit's UV latitude is the geocentric angle of the object direction.
      const cosLat = Math.cos((lat * Math.PI) / 180);
      expect(Math.abs(((texLon - lon + 540) % 360) - 180) * cosLat).toBeLessThanOrEqual(UV_TOL_DEG);
      expect(Math.abs(texLat - geocentricLat(lon, lat))).toBeLessThanOrEqual(UV_TOL_DEG);
      // ...and the texture draws this geodetic point at exactly that row/column.
      const [tx, ty] = lonLatToTexel(lon, lat, 360, 180);
      expect(Math.abs(tx - (texLon + 180)) * cosLat).toBeLessThanOrEqual(UV_TOL_DEG);
      expect(Math.abs(ty - (90 - texLat))).toBeLessThanOrEqual(UV_TOL_DEG);
    });
  }
  for (const [name, [lon, lat]] of Object.entries(LAND)) {
    it(`${name} is land on the texture data`, () => expect(isLand(lon, lat, land)).toBe(true));
  }
  for (const [name, [lon, lat]] of Object.entries(OCEAN)) {
    it(`${name} is ocean on the texture data`, () => expect(isLand(lon, lat, land)).toBe(false));
  }
});

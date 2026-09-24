import { readFileSync } from "node:fs";
import type { FeatureCollection } from "geojson";
import * as THREE from "three";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import { describe, expect, it } from "vitest";
import { lonLatToTexel } from "@/components/globe/earthTexture";
import { geodeticToEcef } from "@/lib/geo";
import { isLand } from "@/lib/landMask";
import { ecefToScene } from "@/lib/orbit";

const topo = JSON.parse(readFileSync(new URL("../../public/geo/land-50m.json", import.meta.url), "utf8")) as Topology;
const land = feature(topo, topo.objects.land) as unknown as FeatureCollection;

const LAND = { Cairo: [31.24, 30.04], Sahara: [13, 23], Denver: [-104.99, 39.74], "Buenos Aires": [-58.38, -34.6], Beijing: [116.4, 39.9], Sydney: [151.0, -33.8], Chukotka: [175.0, 66.0] };
const OCEAN = { "mid-Pacific": [-150, 0], "South Atlantic": [-15, -30], "Indian Ocean": [80, -20], "Bering Sea": [-178.0, 57.0] };

/** Where on the actual Earth mesh (SphereGeometry(1,128,96), as in Earth.tsx) a lat/lon lands: ray from outside toward the centre, read the interpolated UV. */
function meshUv(lon: number, lat: number): THREE.Vector2 {
  const [x, y, z] = geodeticToEcef(lat, lon, 0);
  const s = new Float32Array(3);
  ecefToScene(x, y, z, s, 0);
  const dir = new THREE.Vector3(s[0], s[1], s[2]).normalize();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), new THREE.MeshBasicMaterial());
  const ray = new THREE.Raycaster(dir.clone().multiplyScalar(3), dir.clone().negate());
  const hit = ray.intersectObject(mesh)[0];
  return hit.uv!;
}

describe("T6 globe alignment", () => {
  for (const [name, [lon, lat]] of Object.entries({ ...LAND, ...OCEAN })) {
    it(`${name}: the mesh point for its lat/lon samples the texture at that lat/lon`, () => {
      const uv = meshUv(lon, lat);
      const [tx, ty] = lonLatToTexel(lon, lat, 360, 180);
      const texLon = uv.x * 360 - 180;
      const texLat = uv.y * 180 - 90; // CanvasTexture flipY: canvas row 0 (north) is v = 1
      expect(Math.abs(((texLon - lon + 540) % 360) - 180)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(texLat - lat)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(tx - (lon + 180))).toBeLessThan(1e-9); // lonLatToTexel agrees with the same convention
      expect(Math.abs(ty - (90 - lat))).toBeLessThan(1e-9);
    });
  }
  for (const [name, [lon, lat]] of Object.entries(LAND)) {
    it(`${name} is land on the texture data`, () => expect(isLand(lon, lat, land)).toBe(true));
  }
  for (const [name, [lon, lat]] of Object.entries(OCEAN)) {
    it(`${name} is ocean on the texture data`, () => expect(isLand(lon, lat, land)).toBe(false));
  }
});

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

function tint(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const geo = g.toNonIndexed();
  const c = new THREE.Color(hex);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** Satellite: cream body, blue panels (payload colour), small dish. Uses vertex colours. */
export function createSatelliteGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.6, 0.6, 0.9);
  const p1 = new THREE.BoxGeometry(1.5, 0.05, 0.6).translate(-1.1, 0, 0);
  const p2 = new THREE.BoxGeometry(1.5, 0.05, 0.6).translate(1.1, 0, 0);
  const dish = new THREE.ConeGeometry(0.28, 0.25, 12).rotateX(Math.PI / 2).translate(0, 0, 0.55);
  return mergeGeometries([tint(body, "#f2efe6"), tint(p1, "#3987e5"), tint(p2, "#3987e5"), tint(dish, "#d8d4c8")])!;
}

/** Rocket body: cylinder + nose cone + nozzle, pointing along +Z. */
export function createRocketBodyGeometry(): THREE.BufferGeometry {
  const cyl = new THREE.CylinderGeometry(0.32, 0.32, 1.5, 14).toNonIndexed();
  const nose = new THREE.ConeGeometry(0.32, 0.55, 14).translate(0, 1.02, 0).toNonIndexed();
  const nozzle = new THREE.CylinderGeometry(0.18, 0.3, 0.25, 12).translate(0, -0.87, 0).toNonIndexed();
  return mergeGeometries([cyl, nose, nozzle])!.rotateX(Math.PI / 2);
}

/** Debris: a jagged, flattened shard. */
export function createDebrisGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.55, 0).toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = 0.55 + Math.abs(Math.sin(i * 12.9898) * 0.9);
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.6, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

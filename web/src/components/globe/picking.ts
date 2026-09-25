import * as THREE from "three";
import type { OrbitRecord } from "@/lib/snapshot";
import type { PropagationFrames } from "@/components/globe/usePropagation";
import { interpolate } from "@/components/globe/instances";
import { EARTH_RADIUS } from "@/components/globe/Earth";

export type PickSource = { records: OrbitRecord[]; visible: boolean[]; frames: PropagationFrames };

const TIE_PX2 = 0.25 * 0.25;
const p = new THREE.Vector3();
const ndc = new THREE.Vector3();
const toPoint = new THREE.Vector3();

/** Whether the Earth sphere blocks the line of sight from the camera to a point. */
function behindEarth(cam: THREE.Vector3, point: THREE.Vector3): boolean {
  toPoint.subVectors(point, cam);
  const a = toPoint.lengthSq(), b = 2 * cam.dot(toPoint), c = cam.lengthSq() - EARTH_RADIUS * EARTH_RADIUS;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return false;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 && t < 1;
}

/** NORAD ID of the visible object drawn nearest a pointer position (CSS px within the canvas), within `radius`
 * px, or null. Objects behind the Earth or the camera are skipped; ties go to the object nearer the camera. */
export function pickObject(
  sources: (PickSource | undefined)[],
  timeMs: number,
  camera: THREE.Camera,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): number | null {
  const cam = camera.getWorldPosition(new THREE.Vector3());
  let best: number | null = null, bestD2 = radius * radius, bestDepth = Infinity;
  for (const s of sources) {
    if (!s) continue;
    for (let i = 0; i < s.records.length; i++) {
      if (!s.visible[i] || !interpolate(s.frames.current, timeMs, i, p)) continue;
      ndc.copy(p).project(camera);
      if (ndc.z < -1 || ndc.z > 1) continue;
      const dx = ((ndc.x + 1) / 2) * width - x, dy = ((1 - ndc.y) / 2) * height - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > bestD2 + TIE_PX2) continue;
      const depth = p.distanceToSquared(cam);
      // Within a quarter pixel counts as the same spot on screen: the nearer object wins.
      if (d2 > bestD2 - TIE_PX2 && best !== null && depth >= bestDepth) continue;
      if (behindEarth(cam, p)) continue;
      best = s.records[i].noradId;
      bestD2 = d2;
      bestDepth = depth;
    }
  }
  return best;
}

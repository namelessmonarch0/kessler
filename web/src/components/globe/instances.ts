import * as THREE from "three";

type Frames = { prev: Float32Array | null; next: Float32Array | null; prevTime: number; nextTime: number };

export function objectSize(cameraDistance: number): number {
  return 0.0042 * Math.pow(cameraDistance, 0.55);
}

/**
 * three's InstancedMesh.raycast() computes and caches `boundingSphere` lazily on the first
 * raycast call (`if (this.boundingSphere === null) this.computeBoundingSphere()`). Instances
 * start out zero-scale (see `writeInstance` below) until the propagation worker delivers its
 * first frame; if the pointer hovers the globe before that, the cached sphere collapses to a
 * dead, effectively radius-0 sphere at the origin and every instance becomes permanently
 * unpickable. Assigning one fixed, generous sphere once at creation — instead of letting three
 * compute it from whatever matrices happen to be present at the first raycast — sidesteps the
 * cache entirely: it's already non-null, so three never recomputes it from live (possibly
 * zero-scale) instance data.
 */
export function initBoundingSphere(mesh: THREE.InstancedMesh, radius: number): void {
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), radius);
}

export function interpolate(frames: Frames, timeMs: number, i: number, out: THREE.Vector3): boolean {
  const { prev, next, prevTime, nextTime } = frames;
  if (!prev || !next) return false;
  const a = nextTime > prevTime ? Math.min(Math.max((timeMs - prevTime) / (nextTime - prevTime), 0), 1.5) : 1;
  const k = i * 3;
  const x = prev[k] + (next[k] - prev[k]) * a;
  const y = prev[k + 1] + (next[k + 1] - prev[k + 1]) * a;
  const z = prev[k + 2] + (next[k + 2] - prev[k + 2]) * a;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  out.set(x, y, z);
  return true;
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export function writeInstance(
  matrix: THREE.Matrix4,
  pos: THREE.Vector3 | null,
  vel: THREE.Vector3,
  size: number,
  spin: number,
  dummy: THREE.Object3D,
): void {
  if (!pos) {
    matrix.copy(ZERO);
    return;
  }
  dummy.position.copy(pos);
  dummy.up.copy(pos).normalize();
  dummy.lookAt(pos.x + vel.x, pos.y + vel.y, pos.z + vel.z);
  if (spin) {
    dummy.rotateX(spin);
    dummy.rotateY(spin * 1.3);
  }
  dummy.scale.setScalar(size);
  dummy.updateMatrix();
  matrix.copy(dummy.matrix);
}

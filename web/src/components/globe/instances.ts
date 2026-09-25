import * as THREE from "three";

type Frames = { prev: Float32Array | null; next: Float32Array | null; prevTime: number; nextTime: number };

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

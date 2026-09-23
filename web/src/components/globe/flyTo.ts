import { animate } from "animejs";
import * as THREE from "three";
import { prefersReducedMotion } from "@/lib/motion";

export function shortestAngle(from: number, to: number): number {
  const d = to - from;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

export type Locator = (id: number) => THREE.Vector3 | null;

/**
 * Finds the first non-null position across a set of locator functions, one per object group
 * (e.g. LEO, HIGH). The set can be sparse — a group whose snapshot hasn't loaded (or failed)
 * yet leaves a hole rather than a function — so holes are skipped instead of called.
 */
export function findPosition(locators: readonly (Locator | undefined)[], id: number): THREE.Vector3 | null {
  for (const find of locators) {
    if (!find) continue;
    const p = find(id);
    if (p) return p;
  }
  return null;
}

/** Arcs the camera around the globe (never through it) to look at `target` from `distance`. */
export function flyTo(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  distance: number,
  onDone?: () => void,
): { cancel(): void } {
  const from = new THREE.Spherical().setFromVector3(camera.position);
  const to = new THREE.Spherical().setFromVector3(target.clone().normalize().multiplyScalar(distance));
  const apply = (r: number, phi: number, theta: number) => {
    camera.position.setFromSpherical(new THREE.Spherical(r, phi, theta));
    camera.lookAt(0, 0, 0);
  };
  if (prefersReducedMotion()) {
    apply(to.radius, to.phi, to.theta);
    onDone?.();
    return { cancel() {} };
  }
  const s = { r: from.radius, phi: from.phi, theta: from.theta };
  const anim = animate(s, {
    r: [from.radius, Math.max(from.radius, to.radius) + 0.6, to.radius],
    phi: to.phi,
    theta: from.theta + shortestAngle(from.theta, to.theta),
    duration: 2000,
    ease: "inOutQuart",
    onUpdate: () => apply(s.r, s.phi, s.theta),
    onComplete: () => onDone?.(),
  });
  return { cancel: () => anim.pause() };
}

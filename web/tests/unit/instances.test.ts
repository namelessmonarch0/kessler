import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { interpolate, objectSize, writeInstance } from "@/components/globe/instances";

describe("objectSize", () => {
  it("shrinks slower than distance so shapes grow on screen when zooming in", () => {
    expect(objectSize(1)).toBeCloseTo(0.0042, 6);
    const near = objectSize(1.3) / 0.3;
    const far = objectSize(4) / 3;
    expect(near).toBeGreaterThan(far * 5);
  });
});

describe("interpolate", () => {
  const frames = {
    prev: new Float32Array([1, 0, 0, NaN, NaN, NaN]),
    next: new Float32Array([0, 1, 0, 1, 1, 1]),
    prevTime: 1000,
    nextTime: 2000,
  };
  it("interpolates linearly between frames", () => {
    const v = new THREE.Vector3();
    expect(interpolate(frames, 1500, 0, v)).toBe(true);
    expect(v.toArray()).toEqual([0.5, 0.5, 0]);
  });
  it("reports NaN positions as not drawable", () => {
    expect(interpolate(frames, 1500, 1, new THREE.Vector3())).toBe(false);
  });
  it("is not drawable before any frame exists", () => {
    expect(interpolate({ prev: null, next: null, prevTime: 0, nextTime: 0 }, 0, 0, new THREE.Vector3())).toBe(false);
  });
});

describe("writeInstance", () => {
  it("instance transform hides NaN positions", () => {
    const m = new THREE.Matrix4();
    writeInstance(m, null, new THREE.Vector3(1, 0, 0), 0.01, 0, new THREE.Object3D());
    // three 0.186's Matrix4.decompose() short-circuits any zero-determinant matrix to
    // scale (1,1,1) (see Matrix4.js decompose(), det === 0 branch), so a true zero-scale
    // matrix can never round-trip to scale.length() === 0 via decompose in this version.
    // Assert on the raw linear-part elements instead.
    expect(Array.from(m.elements)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });
  it("places visible objects at their position with the requested size", () => {
    const m = new THREE.Matrix4();
    writeInstance(m, new THREE.Vector3(0, 1.1, 0), new THREE.Vector3(1, 0, 0), 0.02, 0, new THREE.Object3D());
    const p = new THREE.Vector3(); const s = new THREE.Vector3();
    m.decompose(p, new THREE.Quaternion(), s);
    expect(p.y).toBeCloseTo(1.1, 6);
    expect(s.x).toBeCloseTo(0.02, 6);
  });
});

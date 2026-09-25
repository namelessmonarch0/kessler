import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { interpolate } from "@/components/globe/instances";

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

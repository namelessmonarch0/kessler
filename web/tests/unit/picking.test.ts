import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { pickObject, type PickSource } from "@/components/globe/picking";
import type { OrbitRecord } from "@/lib/snapshot";

const W = 800, H = 600;
const camera = new THREE.PerspectiveCamera(40, W / H, 0.005, 100);
camera.position.set(0, 0, 4);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

/** A source whose objects sit still at the given scene positions. */
function source(points: [number, number, number][], ids: number[], visible = points.map(() => true)): PickSource {
  const arr = new Float32Array(points.flat());
  return {
    records: ids.map((noradId) => ({ noradId }) as OrbitRecord),
    visible,
    frames: { current: { prev: arr, next: arr, prevTime: 0, nextTime: 1 } },
  };
}
/** CSS px where a scene point lands. */
function screen(p: [number, number, number]): [number, number] {
  const v = new THREE.Vector3(...p).project(camera);
  return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H];
}

describe("pickObject", () => {
  const front: [number, number, number] = [0.3, 0.2, 1.2];
  it("returns the object under the pointer", () => {
    const [x, y] = screen(front);
    expect(pickObject([source([front], [42])], 0, camera, x + 3, y - 2, W, H, 8)).toBe(42);
  });
  it("returns null outside the radius", () => {
    const [x, y] = screen(front);
    expect(pickObject([source([front], [42])], 0, camera, x + 12, y, W, H, 8)).toBeNull();
  });
  it("picks the nearest of several, across sources", () => {
    const a: [number, number, number] = [0.3, 0.2, 1.2], b: [number, number, number] = [0.33, 0.2, 1.2];
    const [bx, by] = screen(b);
    expect(pickObject([source([a], [1]), source([b], [2])], 0, camera, bx + 1, by, W, H, 16)).toBe(2);
  });
  it("skips objects hidden by the filters", () => {
    const [x, y] = screen(front);
    expect(pickObject([source([front], [42], [false])], 0, camera, x, y, W, H, 8)).toBeNull();
  });
  it("skips objects behind the Earth", () => {
    const behind: [number, number, number] = [0.1, 0.1, -1.3];
    const [x, y] = screen(behind);
    expect(pickObject([source([behind], [7])], 0, camera, x, y, W, H, 8)).toBeNull();
  });
  it("breaks a tie in screen distance toward the object nearer the camera", () => {
    const offEarth: [number, number, number] = [0.6, 0, 2.5];
    const farOff: [number, number, number] = [1.2, 0, 1]; // camera + 2 × (offEarth − camera): same ray, farther
    const [x, y] = screen(offEarth);
    expect(pickObject([source([farOff, offEarth], [2, 1])], 0, camera, x, y, W, H, 8)).toBe(1);
    expect(pickObject([source([offEarth, farOff], [1, 2])], 0, camera, x, y, W, H, 8)).toBe(1);
  });
  it("returns null before any frame exists", () => {
    const s: PickSource = { records: [{ noradId: 1 } as OrbitRecord], visible: [true], frames: { current: { prev: null, next: null, prevTime: 0, nextTime: 0 } } };
    expect(pickObject([s], 0, camera, 400, 300, W, H, 8)).toBeNull();
  });
});

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { initBoundingSphere, interpolate, objectSize, writeInstance } from "@/components/globe/instances";

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

describe("initBoundingSphere", () => {
  // Regression test for: InstancedMesh.raycast (three's InstancedMesh.js) computes and caches
  // `boundingSphere` lazily on the *first* raycast call (`if (this.boundingSphere === null)
  // this.computeBoundingSphere()`). If every instance matrix is still zero-scale at that first
  // call (e.g. the pointer hovers the globe before the propagation worker's first frame),
  // computeBoundingSphere() unions a degenerate, effectively radius-0 sphere at the origin and
  // three caches it forever — so instances never become pickable again, even once real,
  // non-zero matrices are written. Fixing it by calling `computeBoundingSphere()` again after
  // real matrices land isn't enough on its own if the caller forgets to do it every time new
  // matrices arrive; assigning one fixed, generous sphere up front sidesteps the whole cache.
  function buildMesh(radius: number) {
    const geometry = new THREE.BoxGeometry(0.02, 0.02, 0.02);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, 1);
    // Start with a zero-scale instance matrix, exactly as writeInstance(..., null, ...) does
    // before the first worker frame has arrived.
    mesh.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.updateMatrixWorld(true);
    if (radius > 0) initBoundingSphere(mesh, radius);
    return mesh;
  }

  function raycastAt(mesh: THREE.InstancedMesh, target: THREE.Vector3): THREE.Intersection[] {
    const raycaster = new THREE.Raycaster();
    const origin = target.clone().add(new THREE.Vector3(0, 0, 5));
    const direction = target.clone().sub(origin).normalize();
    raycaster.set(origin, direction);
    const intersects: THREE.Intersection[] = [];
    mesh.raycast(raycaster, intersects);
    return intersects;
  }

  it("without a fixed sphere, a raycast while matrices are zero permanently caches a dead sphere", () => {
    const mesh = buildMesh(0); // no initBoundingSphere call — reproduces the bug
    const target = new THREE.Vector3(0, 1.1, 0);
    expect(raycastAt(mesh, target)).toEqual([]); // first hover: nothing to hit yet, as expected

    // A real worker frame lands and the renderer writes a real transform for this instance.
    const m = new THREE.Matrix4();
    writeInstance(m, target, new THREE.Vector3(1, 0, 0), 0.02, 0, new THREE.Object3D());
    mesh.setMatrixAt(0, m);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.updateMatrixWorld(true);

    // Bug: the coarse boundingSphere test was cached as empty/zero-radius on the first raycast
    // above and is never recomputed, so the now-real instance is still unreachable.
    expect(raycastAt(mesh, target)).toEqual([]);
  });

  it("with initBoundingSphere set at creation, a hover before the first frame does not break picking once real matrices arrive", () => {
    const mesh = buildMesh(1.4); // LEO-sized fixed picking sphere, set once at creation
    const target = new THREE.Vector3(0, 1.1, 0);
    expect(raycastAt(mesh, target)).toEqual([]); // still nothing drawn yet — zero-scale instance

    const m = new THREE.Matrix4();
    writeInstance(m, target, new THREE.Vector3(1, 0, 0), 0.02, 0, new THREE.Object3D());
    mesh.setMatrixAt(0, m);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.updateMatrixWorld(true);

    const hits = raycastAt(mesh, target);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].instanceId).toBe(0);
  });
});

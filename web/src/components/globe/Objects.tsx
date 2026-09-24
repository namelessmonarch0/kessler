"use client";

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import { isVisible, useExplorer } from "@/lib/store";
import { GLOBE_COLORS, type ObjectType } from "@/lib/types";
import { usePropagation } from "@/components/globe/usePropagation";
import { initBoundingSphere, interpolate, objectSize, writeInstance } from "@/components/globe/instances";
import { createDebrisGeometry, createRocketBodyGeometry, createSatelliteGeometry } from "@/components/globe/objectGeometries";

type Kind = "sat" | "rb" | "deb";
const kindOf = (t: ObjectType): Kind => (t === "PAY" ? "sat" : t === "R/B" ? "rb" : "deb");
// Fix round 1 bumped these to rb:1.8/deb:1.6, reasoning from debris/rocket-body geometry being
// intrinsically smaller on screen than a satellite's wide solar panels. But that measurement was
// taken against the *local* dev DB, which (no Space-Track credentials locally) has ~0 real
// debris/rocket-body position records — so the low pixel share measured there was a data gap, not
// evidence the base size reads poorly. Re-measured in fix round 2 against the real production API
// (full Space-Track catalog, ~9k debris/~1k rocket bodies in LEO): at these original values,
// debris alone is 34.85% of object-cloud pixels and rocket bodies 2.81% — both clearly, visibly
// present (see task-2-report.md's fix-round-2 section) — so the boost wasn't needed after all.
const SIZE_FACTOR: Record<Kind, number> = { sat: 1, rb: 1.15, deb: 1.0 };

export function Objects({
  records,
  group,
  onReady,
  active = true,
}: {
  records: OrbitRecord[];
  group: "LEO" | "HIGH";
  onReady?: (positionOf: (noradId: number) => THREE.Vector3 | null) => void;
  /** Whether the globe is visible/foregrounded — see GlobeSection/GlobeScene. Pauses the
   * propagation worker's tick interval while false. */
  active?: boolean;
}) {
  const frames = usePropagation(records, active);
  const camera = useThree((s) => s.camera);
  const types = useExplorer((s) => s.types);
  const owners = useExplorer((s) => s.owners);
  const orbits = useExplorer((s) => s.orbits);
  const selectedId = useExplorer((s) => s.selectedId);
  const select = useExplorer((s) => s.select);

  const buckets = useMemo(() => {
    const idx: Record<Kind, number[]> = { sat: [], rb: [], deb: [] };
    records.forEach((r, i) => idx[kindOf(r.type)].push(i));
    return idx;
  }, [records]);

  const visible = useMemo(
    () => records.map((r) => isVisible(r, group, { types, owners, orbits })),
    [records, group, types, owners, orbits],
  );

  const geometries = useMemo(
    () => ({ sat: createSatelliteGeometry(), rb: createRocketBodyGeometry(), deb: createDebrisGeometry() }),
    [],
  );
  const materials = useMemo(() => {
    // 2-step ramp (rather than 3) plus each material's emissive set to 60% of its own globe
    // colour: at the 1-2 px instance size objects render at, MeshToonMaterial's lit colour
    // collapses toward the dark/gray end of the ramp, which washed out debris/rocket-body hues
    // almost entirely (review finding on b6f98f8's shot: ~94.5% of object pixels read near-gray).
    // A strong, colour-matched emissive keeps each kind's hue visible regardless of shading.
    // Fix round 2 confirmed against the real production catalog that these hues read clearly
    // (debris 34.85%, rocket bodies 2.81% of object-cloud pixels; rocket bodies read paler than
    // debris — directional-light + emissive overexposes R/B's high-blue base colour toward white
    // faster than DEB's low-blue one — but are still visibly, distinctly lavender, not gray).
    const ramp = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255, 255, 255, 255, 255]), 2, 1);
    ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
    ramp.needsUpdate = true;
    return {
      sat: new THREE.MeshToonMaterial({
        vertexColors: true,
        color: GLOBE_COLORS.PAY,
        gradientMap: ramp,
        emissive: new THREE.Color(GLOBE_COLORS.PAY).multiplyScalar(0.6),
      }),
      rb: new THREE.MeshToonMaterial({
        color: GLOBE_COLORS["R/B"],
        gradientMap: ramp,
        emissive: new THREE.Color(GLOBE_COLORS["R/B"]).multiplyScalar(0.6),
      }),
      deb: new THREE.MeshToonMaterial({
        color: GLOBE_COLORS.DEB,
        gradientMap: ramp,
        emissive: new THREE.Color(GLOBE_COLORS.DEB).multiplyScalar(0.6),
      }),
    };
  }, []);
  useEffect(
    () => () => {
      Object.values(geometries).forEach((g) => g.dispose());
      Object.values(materials).forEach((m) => m.dispose());
    },
    [geometries, materials],
  );

  const satRef = useRef<THREE.InstancedMesh>(null);
  const rbRef = useRef<THREE.InstancedMesh>(null);
  const debRef = useRef<THREE.InstancedMesh>(null);
  const meshes = useMemo(() => ({ sat: satRef, rb: rbRef, deb: debRef }), []);

  // Fix a generous picking sphere on each instanced mesh once, at creation, before any raycast
  // can run — see initBoundingSphere's comment. Radius is a loose bound on the LEO/HIGH object
  // clouds in scene units (Earth radius = 1); it only gates the coarse "does the ray pass near
  // this mesh at all" test, so being generous costs nothing.
  useEffect(() => {
    const radius = group === "LEO" ? 1.4 : 8;
    (Object.keys(meshes) as Kind[]).forEach((kind) => {
      const mesh = meshes[kind].current;
      if (mesh) initBoundingSphere(mesh, radius);
    });
  }, [group, meshes, buckets]);
  const scratch = useMemo(
    () => ({ pos: new THREE.Vector3(), ahead: new THREE.Vector3(), vel: new THREE.Vector3(), m: new THREE.Matrix4(), dummy: new THREE.Object3D() }),
    [],
  );

  const indexById = useMemo(() => new Map(records.map((r, i) => [r.noradId, i])), [records]);
  useEffect(() => {
    onReady?.((noradId) => {
      const i = indexById.get(noradId);
      const v = new THREE.Vector3();
      return i !== undefined && interpolate(frames.current, simClock.now(), i, v) ? v : null;
    });
  }, [indexById, frames, onReady]);

  useFrame(() => {
    const now = simClock.now();
    const size = objectSize(camera.position.length());
    const { pos, ahead, vel, m, dummy } = scratch;
    (Object.keys(buckets) as Kind[]).forEach((kind) => {
      const mesh = meshes[kind].current;
      if (!mesh) return;
      buckets[kind].forEach((recordIndex, instance) => {
        const drawable = visible[recordIndex] && interpolate(frames.current, now, recordIndex, pos);
        if (drawable) {
          if (interpolate(frames.current, now + 1000 * simClock.scale, recordIndex, ahead)) vel.subVectors(ahead, pos);
          else vel.set(1, 0, 0);
        }
        const selectedBoost = records[recordIndex].noradId === selectedId ? 2.2 : 1;
        const spin = kind === "deb" ? (recordIndex % 97) * 0.13 + now * 0.0004 : 0;
        writeInstance(m, drawable ? pos : null, vel, size * SIZE_FACTOR[kind] * selectedBoost, spin, dummy);
        mesh.setMatrixAt(instance, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  });

  const onClick = (kind: Kind) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId === undefined) return;
    select(records[buckets[kind][e.instanceId]].noradId);
  };

  return (
    <>
      {(Object.keys(buckets) as Kind[]).map((kind) =>
        buckets[kind].length ? (
          <instancedMesh
            key={kind}
            ref={meshes[kind]}
            args={[geometries[kind], materials[kind], buckets[kind].length]}
            frustumCulled={false}
            onClick={onClick(kind)}
            onPointerOver={() => (document.body.style.cursor = "pointer")}
            onPointerOut={() => (document.body.style.cursor = "")}
          />
        ) : null,
      )}
    </>
  );
}

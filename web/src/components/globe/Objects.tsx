"use client";

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import { isVisible, useExplorer } from "@/lib/store";
import { TYPE_COLORS, type ObjectType } from "@/lib/types";
import { usePropagation } from "@/components/globe/usePropagation";
import { interpolate, objectSize, writeInstance } from "@/components/globe/instances";
import { createDebrisGeometry, createRocketBodyGeometry, createSatelliteGeometry } from "@/components/globe/objectGeometries";

type Kind = "sat" | "rb" | "deb";
const kindOf = (t: ObjectType): Kind => (t === "PAY" ? "sat" : t === "R/B" ? "rb" : "deb");
const SIZE_FACTOR: Record<Kind, number> = { sat: 1, rb: 1.15, deb: 0.8 };

export function Objects({
  records,
  group,
  onReady,
}: {
  records: OrbitRecord[];
  group: "LEO" | "HIGH";
  onReady?: (positionOf: (noradId: number) => THREE.Vector3 | null) => void;
}) {
  const frames = usePropagation(records);
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
    const ramp = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]), 3, 1);
    ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
    ramp.needsUpdate = true;
    return {
      sat: new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, emissive: "#222222" }),
      rb: new THREE.MeshToonMaterial({ color: TYPE_COLORS["R/B"], gradientMap: ramp, emissive: "#062a1e" }),
      deb: new THREE.MeshToonMaterial({ color: TYPE_COLORS.DEB, gradientMap: ramp, emissive: "#3a1006" }),
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

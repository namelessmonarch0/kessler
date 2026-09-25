"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { earthRadiusPx } from "@/lib/camera";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import { isVisible, useExplorer } from "@/lib/store";
import { usePropagation, type PropagationFrames } from "@/components/globe/usePropagation";
import { interpolate } from "@/components/globe/instances";
import { applyFrame, buildObjectGeometry, frameAlpha, lodFade, setVisibility } from "@/components/globe/objectPoints";
import { createObjectMaterial, updateObjectUniforms } from "@/components/globe/objectMaterial";
import { createAtlasTexture } from "@/components/globe/spriteAtlas";
import { Selection } from "@/components/globe/Selection";

export type LabelSource = { group: "LEO" | "HIGH"; records: OrbitRecord[]; visible: boolean[]; frames: PropagationFrames };

/** Every object of one orbit group as a single GPU point cloud of pixel sprites (see objectMaterial). Per frame
 * the CPU only sets uniforms; positions reach the GPU once per worker tick. */
export function Objects({
  records,
  group,
  onReady,
  active = true,
  onLabelSource,
}: {
  records: OrbitRecord[];
  group: "LEO" | "HIGH";
  onReady?: (positionOf: (noradId: number) => THREE.Vector3 | null) => void;
  /** Whether the globe is visible/foregrounded — see GlobeSection/GlobeScene. Pauses the
   * propagation worker's tick interval while false. */
  active?: boolean;
  /** Reports this group's live records/visibility/frames for LabelDriver (and picking) to read from — see
   * GlobeScene, which fans these into a `labelSources` ref by group index. */
  onLabelSource?: (s: LabelSource | null) => void;
}) {
  const { frames, requestPath } = usePropagation(records, active);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const height = useThree((s) => s.size.height);
  const types = useExplorer((s) => s.types);
  const owners = useExplorer((s) => s.owners);
  const orbits = useExplorer((s) => s.orbits);
  const selectedId = useExplorer((s) => s.selectedId);

  const visible = useMemo(
    () => records.map((r) => isVisible(r, group, { types, owners, orbits })),
    [records, group, types, owners, orbits],
  );

  const atlas = useMemo(() => createAtlasTexture(), []);
  const material = useMemo(() => createObjectMaterial(atlas), [atlas]);
  const geometry = useMemo(() => buildObjectGeometry(records), [records]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(
    () => () => {
      material.dispose();
      atlas.dispose();
    },
    [material, atlas],
  );
  useEffect(() => setVisibility(geometry, visible), [geometry, visible]);

  const indexById = useMemo(() => new Map(records.map((r, i) => [r.noradId, i])), [records]);
  useEffect(() => {
    onReady?.((noradId) => {
      const i = indexById.get(noradId);
      const v = new THREE.Vector3();
      return i !== undefined && interpolate(frames.current, simClock.now(), i, v) ? v : null;
    });
  }, [indexById, frames, onReady]);

  useEffect(() => {
    onLabelSource?.({ group, records, visible, frames });
    return () => onLabelSource?.(null);
  }, [group, records, visible, frames, onLabelSource]);

  const points = useRef<THREE.Points>(null);
  const uploaded = useRef<{ geometry: THREE.BufferGeometry | null; next: Float32Array | null }>({ geometry: null, next: null });
  useFrame(() => {
    const f = frames.current;
    if (!points.current) return;
    points.current.visible = !!(f.prev && f.next);
    if (!f.prev || !f.next) return;
    if (uploaded.current.geometry !== geometry || uploaded.current.next !== f.next) {
      applyFrame(geometry, f.prev, f.next);
      uploaded.current = { geometry, next: f.next };
    }
    updateObjectUniforms(material, gl, frameAlpha(f, simClock.now()), lodFade(earthRadiusPx(camera.position.length(), height, camera.fov)));
  });

  const selectedIndex = selectedId === null ? undefined : indexById.get(selectedId);
  return (
    <>
      <points ref={points} geometry={geometry} material={material} frustumCulled={false} visible={false} />
      {selectedIndex !== undefined && (
        <Selection record={records[selectedIndex]} index={selectedIndex} frames={frames} requestPath={requestPath} atlas={atlas} />
      )}
    </>
  );
}

"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer } from "@react-three/postprocessing";
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import { useExplorer } from "@/lib/store";
import { sunDirectionScene } from "@/lib/sun";
import { DitherEffectImpl } from "@/components/globe/DitherEffect";
import { Earth } from "@/components/globe/Earth";
import { flyTo } from "@/components/globe/flyTo";
import { Objects } from "@/components/globe/Objects";

export function GlobeScene({ leo, high }: { leo: OrbitRecord[] | null; high: OrbitRecord[] | null }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const sun = useRef<THREE.DirectionalLight>(null);
  const timeScale = useExplorer((s) => s.timeScale);
  const selectedId = useExplorer((s) => s.selectedId);
  const locators = useRef<((id: number) => THREE.Vector3 | null)[]>([]);
  const dither = useMemo(
    () => new DitherEffectImpl({ cell: 2 * Math.min(window.devicePixelRatio, 2), levels: 7, grain: 0.09 }),
    [],
  );

  useEffect(() => simClock.setScale(timeScale), [timeScale]);

  useEffect(() => {
    if (selectedId === null) return;
    for (const find of locators.current) {
      const p = find(selectedId);
      if (p) {
        const fly = flyTo(camera, p, Math.max(1.35, p.length() + 0.45));
        return () => fly.cancel();
      }
    }
  }, [selectedId, camera]);

  const onReadyLeo = useCallback((f: (id: number) => THREE.Vector3 | null) => (locators.current[0] = f), []);
  const onReadyHigh = useCallback((f: (id: number) => THREE.Vector3 | null) => (locators.current[1] = f), []);

  useFrame((_, dt) => {
    simClock.tick(Math.min(dt, 0.1) * 1000);
    const [x, y, z] = sunDirectionScene(new Date(simClock.now()));
    sun.current?.position.set(x * 10, y * 10, z * 10);
  });

  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight ref={sun} intensity={2.2} />
      <Earth />
      {leo && <Objects records={leo} group="LEO" onReady={onReadyLeo} />}
      {high && <Objects records={high} group="HIGH" onReady={onReadyHigh} />}
      <OrbitControls enableDamping enablePan={false} minDistance={1.12} maxDistance={9} zoomSpeed={0.8} />
      <EffectComposer multisampling={0}>
        <primitive object={dither} dispose={null} />
      </EffectComposer>
    </>
  );
}

"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer } from "@react-three/postprocessing";
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import { useExplorer } from "@/lib/store";
import { sunDirectionScene } from "@/lib/sun";
import { DitherEffectImpl } from "@/components/globe/DitherEffect";
import { Earth } from "@/components/globe/Earth";
import { findPosition, flyTo, type Locator } from "@/components/globe/flyTo";
import { Objects } from "@/components/globe/Objects";

export function GlobeScene({ leo, high }: { leo: OrbitRecord[] | null; high: OrbitRecord[] | null }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const sun = useRef<THREE.DirectionalLight>(null);
  const controls = useRef<OrbitControlsImpl>(null);
  const timeScale = useExplorer((s) => s.timeScale);
  const selectedId = useExplorer((s) => s.selectedId);
  // Sparse: index 0 = LEO, 1 = HIGH. A group whose snapshot hasn't loaded (or errored) yet
  // leaves a hole here rather than a function — findPosition skips holes instead of calling them.
  const locators = useRef<(Locator | undefined)[]>([]);
  const dither = useMemo(
    () => new DitherEffectImpl({ cell: 2 * Math.min(window.devicePixelRatio, 2), levels: 7, grain: 0.09 }),
    [],
  );

  useEffect(() => simClock.setScale(timeScale), [timeScale]);

  useEffect(() => {
    if (selectedId === null) return;
    const p = findPosition(locators.current, selectedId);
    if (!p) return;
    // OrbitControls and the fly-to tween both write camera.position; hand off control to the
    // tween for its duration so they don't fight, then resync OrbitControls' internal state
    // (damping offset etc.) from wherever the camera ended up before handing control back.
    const resume = () => {
      const c = controls.current;
      if (!c) return;
      c.enabled = true;
      c.update();
    };
    if (controls.current) controls.current.enabled = false;
    const fly = flyTo(camera, p, Math.max(1.35, p.length() + 0.45), resume);
    return () => {
      fly.cancel();
      resume();
    };
  }, [selectedId, camera]);

  const onReadyLeo = useCallback((f: Locator) => (locators.current[0] = f), []);
  const onReadyHigh = useCallback((f: Locator) => (locators.current[1] = f), []);

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
      <OrbitControls ref={controls} enableDamping enablePan={false} minDistance={1.12} maxDistance={9} zoomSpeed={0.8} />
      <EffectComposer multisampling={0}>
        <primitive object={dither} dispose={null} />
      </EffectComposer>
    </>
  );
}

"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { phoneInitialDistance, phoneViewOffset, sheetCoveredHeight } from "@/lib/camera";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import { useExplorer } from "@/lib/store";
import { sunDirectionScene } from "@/lib/sun";
import { Earth } from "@/components/globe/Earth";
import { findPosition, flyTo, type Locator } from "@/components/globe/flyTo";
import { Objects } from "@/components/globe/Objects";

declare global {
  interface Window {
    /** Test-only hook: set before navigation to force the globe's render tree to throw, so
     * GlobeErrorBoundary's fallback path can be exercised end-to-end. Read only outside
     * production (see below) — this flag has no effect in a production build. */
    __LEO_FORCE_GLOBE_ERROR__?: boolean;
  }
}

export function GlobeScene({
  leo,
  high,
  active = true,
  labelsRef,
}: {
  leo: OrbitRecord[] | null;
  high: OrbitRecord[] | null;
  /** Whether the globe card is visible and the tab is foregrounded — see GlobeSection. Threaded
   * down to each Objects/usePropagation instance to pause the propagation worker's tick
   * interval while nothing is rendering the results. */
  active?: boolean;
  /** DOM overlay for object labels, filled in by Task 7. Unused here. */
  labelsRef?: React.RefObject<HTMLDivElement | null>;
}) {
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined" && window.__LEO_FORCE_GLOBE_ERROR__) {
    throw new Error("Forced globe error (test-only, via window.__LEO_FORCE_GLOBE_ERROR__)");
  }
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const sun = useRef<THREE.DirectionalLight>(null);
  const controls = useRef<OrbitControlsImpl>(null);
  const timeScale = useExplorer((s) => s.timeScale);
  const selectedId = useExplorer((s) => s.selectedId);
  const mobileSheetOpen = useExplorer((s) => s.mobileSheetOpen);
  // Sparse: index 0 = LEO, 1 = HIGH. A group whose snapshot hasn't loaded (or errored) yet
  // leaves a hole here rather than a function — findPosition skips holes instead of calling them.
  const locators = useRef<(Locator | undefined)[]>([]);

  useEffect(() => simClock.setScale(timeScale), [timeScale]);

  useEffect(() => {
    const dir = new THREE.Vector3(0.6, 0.9, 3.6).normalize();
    // Below 640px (the phone breakpoint — see global-constraints.md and useIsMobile) the bottom
    // sheet defaults open, so size the initial distance for that (worst-case, sheet-open) area —
    // not the full screen — so the whole Earth fits above it once the setViewOffset shift below
    // is applied. If the sheet later closes there's simply extra clearance, never a crop.
    const isPhone = size.width < 640;
    const covered = isPhone ? sheetCoveredHeight(size.height, true) : 0;
    camera.position.copy(dir.multiplyScalar(phoneInitialDistance(size.width, size.height, covered)));
    camera.lookAt(0, 0, 0);
    // Once, at mount: later resizes keep whatever zoom the user chose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  // Re-centre the globe's projection above the sheet (open) or on the full screen (closed) as the
  // phone sheet is toggled or the viewport resizes. Desktop/tablet (>=640px) always clears any
  // offset — this never applies there. Doesn't touch camera.position/zoom (OrbitControls owns
  // that after mount) or fight the select-driven flyTo tween below, which also only moves
  // position — setViewOffset is a separate, compositable adjustment to the projection matrix.
  useEffect(() => {
    const isPhone = size.width < 640;
    const covered = isPhone ? sheetCoveredHeight(size.height, mobileSheetOpen) : 0;
    const offset = phoneViewOffset(size.width, size.height, covered);
    if (offset) camera.setViewOffset(offset.fullWidth, offset.fullHeight, offset.offsetX, offset.offsetY, offset.viewWidth, offset.viewHeight);
    else camera.clearViewOffset();
  }, [camera, size.width, size.height, mobileSheetOpen]);

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
      {leo && <Objects records={leo} group="LEO" onReady={onReadyLeo} active={active} />}
      {high && <Objects records={high} group="HIGH" onReady={onReadyHigh} active={active} />}
      <OrbitControls ref={controls} enableDamping enablePan={false} minDistance={1.12} maxDistance={12} zoomSpeed={0.8} />
    </>
  );
}

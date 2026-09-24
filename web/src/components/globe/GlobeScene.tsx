"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { coveredHeightFromSheetTop, phoneInitialDistance, phoneViewOffset } from "@/lib/camera";
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
  sectionRef,
}: {
  leo: OrbitRecord[] | null;
  high: OrbitRecord[] | null;
  /** Whether the globe card is visible and the tab is foregrounded — see GlobeSection. Threaded
   * down to each Objects/usePropagation instance to pause the propagation worker's tick
   * interval while nothing is rendering the results. */
  active?: boolean;
  /** DOM overlay for object labels, filled in by Task 7. Unused here. */
  labelsRef?: React.RefObject<HTMLDivElement | null>;
  /** GlobeSection's outer <section>. Written to (not read) here — a throttled `data-earth-cy`
   * attribute exposing the Earth's current projected screen Y, in CSS px, so tests can verify the
   * globe is actually framed where the phone layout intends it (see the "phone:" e2e test). */
  sectionRef?: React.RefObject<HTMLElement | null>;
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
  const mobileSheetTop = useExplorer((s) => s.mobileSheetTop);
  // Sparse: index 0 = LEO, 1 = HIGH. A group whose snapshot hasn't loaded (or errored) yet
  // leaves a hole here rather than a function — findPosition skips holes instead of calling them.
  const locators = useRef<(Locator | undefined)[]>([]);
  // Guards the initial camera-position effect below so it only ever runs once, even though it now
  // has to wait for a real dependency (the sheet's measured top) rather than firing unconditionally
  // at mount.
  const positioned = useRef(false);

  useEffect(() => simClock.setScale(timeScale), [timeScale]);

  // How much of the bottom of the screen the phone sheet covers right now — 0 on desktop/tablet,
  // when the sheet is collapsed, or before MobileSheet's ResizeObserver has measured it once yet.
  const isPhone = size.width < 640;
  const covered = isPhone && mobileSheetOpen ? coveredHeightFromSheetTop(size.height, mobileSheetTop) : 0;

  useEffect(() => {
    // On phone, with the sheet open, wait for its real measured top (see coveredHeightFromSheetTop
    // in camera.ts — the sheet's rendered height is content-driven, not a fixed fraction of the
    // viewport, so there's no safe guess to size against before that first measurement arrives).
    // Desktop/tablet, or the sheet already closed, need no measurement and proceed immediately.
    if (isPhone && mobileSheetOpen && mobileSheetTop === null) return;
    if (positioned.current) return;
    positioned.current = true;
    const dir = new THREE.Vector3(0.6, 0.9, 3.6).normalize();
    camera.position.copy(dir.multiplyScalar(phoneInitialDistance(size.width, size.height, covered)));
    camera.lookAt(0, 0, 0);
    // Runs once (guarded above): later resizes/sheet changes keep whatever zoom the user chose,
    // and are instead handled by the setViewOffset effect below (a shift, not a zoom change).
  }, [camera, size.width, size.height, isPhone, mobileSheetOpen, mobileSheetTop, covered]);

  // Re-centre the globe's projection above the sheet (open) or on the full screen (closed) as the
  // phone sheet is toggled, its content changes size, or the viewport resizes. Desktop/tablet
  // (>=640px) always clears any offset — this never applies there. Doesn't touch
  // camera.position/zoom (OrbitControls owns that after mount) or fight the select-driven flyTo
  // tween below, which also only moves position — setViewOffset is a separate, compositable
  // adjustment to the projection matrix.
  useEffect(() => {
    const offset = phoneViewOffset(size.width, size.height, covered);
    if (offset) camera.setViewOffset(offset.fullWidth, offset.fullHeight, offset.offsetX, offset.offsetY, offset.viewWidth, offset.viewHeight);
    else camera.clearViewOffset();
  }, [camera, size.width, size.height, covered]);

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

  // Starts past the threshold so the very first frame writes immediately (tests don't have to
  // wait out a full throttle interval before the attribute exists at all).
  const earthCyElapsed = useRef(Infinity);
  const earthCyOrigin = useRef(new THREE.Vector3());
  useFrame((_, dt) => {
    simClock.tick(Math.min(dt, 0.1) * 1000);
    const [x, y, z] = sunDirectionScene(new Date(simClock.now()));
    sun.current?.position.set(x * 10, y * 10, z * 10);

    // Throttled (matches the labels' 250ms cadence — see global-constraints.md) so tests can read
    // where the Earth is actually rendered, without recomputing on every single frame.
    earthCyElapsed.current += dt;
    if (sectionRef?.current && earthCyElapsed.current >= 0.25) {
      earthCyElapsed.current = 0;
      earthCyOrigin.current.set(0, 0, 0).project(camera);
      const cy = ((1 - earthCyOrigin.current.y) / 2) * size.height;
      sectionRef.current.setAttribute("data-earth-cy", cy.toFixed(1));
    }
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

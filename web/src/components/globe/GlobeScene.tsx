"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { earthRadiusPx, initialDistance, sheetInitialDistance, sheetViewOffset } from "@/lib/camera";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import { useExplorer } from "@/lib/store";
import { useIsMobile } from "@/lib/useIsMobile";
import { Earth } from "@/components/globe/Earth";
import { findPosition, flyTo, type Locator } from "@/components/globe/flyTo";
import { LabelDriver } from "@/components/globe/LabelDriver";
import { Objects, type LabelSource } from "@/components/globe/Objects";
import { Picker } from "@/components/globe/Picker";

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
  /** DOM overlay for object labels — filled by LabelDriver below. */
  labelsRef?: React.RefObject<HTMLDivElement | null>;
  /** GlobeSection's outer <section>. Written to (not read) here, outside production only —
   * throttled `data-earth-cy` / `data-earth-top` attributes exposing the Earth's projected centre
   * and top edge, in CSS px, so e2e tests can verify the sheet-layout framing. */
  sectionRef?: React.RefObject<HTMLElement | null>;
}) {
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined" && window.__LEO_FORCE_GLOBE_ERROR__) {
    throw new Error("Forced globe error (test-only, via window.__LEO_FORCE_GLOBE_ERROR__)");
  }
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const controls = useRef<OrbitControlsImpl>(null);
  const selectedId = useExplorer((s) => s.selectedId);
  const sheetTop = useExplorer((s) => s.mobileSheetTop);
  const topBarBottom = useExplorer((s) => s.topBarBottom);
  const sheetLayout = useIsMobile();
  // Sparse: index 0 = LEO, 1 = HIGH. A group whose snapshot hasn't loaded (or errored) yet
  // leaves a hole here rather than a function — findPosition skips holes instead of calling them.
  const locators = useRef<(Locator | undefined)[]>([]);
  // Sparse by group index (0 = LEO, 1 = HIGH), same convention as `locators` above — fed by
  // Objects' onLabelSource and read every tick by LabelDriver.
  const labelSources = useRef<(LabelSource | undefined)[]>([]);
  // The initial camera distance is set exactly once; afterwards zoom belongs to the user.
  const positioned = useRef(false);

  useEffect(() => {
    if (positioned.current) return;
    // Sheet layout: size from a fixed worst case (tallest sheet the CSS allows) — needs only the
    // top bar's height, never the sheet's content-dependent measurement.
    if (sheetLayout && topBarBottom === null) return;
    positioned.current = true;
    const d = sheetLayout ? sheetInitialDistance(size.width, size.height, topBarBottom!) : initialDistance(size.width / Math.max(size.height, 1));
    camera.position.copy(new THREE.Vector3(0.6, 0.9, 3.6).normalize().multiplyScalar(d));
    camera.lookAt(0, 0, 0);
  }, [camera, size.width, size.height, sheetLayout, topBarBottom]);

  // Sheet layout: shift (never scale) the projection so the Earth sits midway between the top bar
  // and the sheet's current top, following tab switches, collapse and resizes. Desktop clears it.
  // Only touches the projection matrix — OrbitControls and flyTo own camera.position.
  useEffect(() => {
    const offset = sheetLayout && topBarBottom !== null && sheetTop !== null ? sheetViewOffset(size.width, size.height, topBarBottom, sheetTop) : null;
    if (offset) camera.setViewOffset(offset.fullWidth, offset.fullHeight, offset.offsetX, offset.offsetY, offset.viewWidth, offset.viewHeight);
    else camera.clearViewOffset();
  }, [camera, size.width, size.height, sheetLayout, topBarBottom, sheetTop]);

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
  const onLeoLabels = useCallback((s: LabelSource | null) => (labelSources.current[0] = s ?? undefined), []);
  const onHighLabels = useCallback((s: LabelSource | null) => (labelSources.current[1] = s ?? undefined), []);

  // Starts past the threshold so the very first frame writes immediately (tests don't have to
  // wait out a full throttle interval before the attribute exists at all).
  const earthCyElapsed = useRef(Infinity);
  const earthCyOrigin = useRef(new THREE.Vector3());
  useFrame((_, dt) => {
    simClock.tick();

    // Test-only (never in production): where the Earth is rendered, throttled to 250 ms.
    if (process.env.NODE_ENV !== "production") {
      earthCyElapsed.current += dt;
      if (sectionRef?.current && earthCyElapsed.current >= 0.25) {
        earthCyElapsed.current = 0;
        earthCyOrigin.current.set(0, 0, 0).project(camera);
        const cy = ((1 - earthCyOrigin.current.y) / 2) * size.height;
        const r = earthRadiusPx(camera.position.length(), size.height, camera.fov);
        sectionRef.current.setAttribute("data-earth-cy", cy.toFixed(1));
        sectionRef.current.setAttribute("data-earth-top", (cy - r).toFixed(1));
      }
    }
  });

  return (
    <>
      <Earth />
      {leo && <Objects records={leo} group="LEO" onReady={onReadyLeo} active={active} onLabelSource={onLeoLabels} />}
      {high && <Objects records={high} group="HIGH" onReady={onReadyHigh} active={active} onLabelSource={onHighLabels} />}
      <OrbitControls ref={controls} enableDamping enablePan={false} minDistance={1.12} maxDistance={12} zoomSpeed={0.8} />
      <Picker sources={labelSources} />
      {labelsRef && <LabelDriver sources={labelSources} container={labelsRef} sheetLayout={sheetLayout} />}
    </>
  );
}

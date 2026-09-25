"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { simClock } from "@/lib/clock";
import { useExplorer } from "@/lib/store";
import { pickObject, type PickSource } from "@/components/globe/picking";

const CLICK_SLOP_PX = 5;
const HOVER_EVERY_MS = 100;

/** Selects the object drawn nearest a click on the globe canvas, and shows the pointer cursor over objects. A
 * press that moves 5 px or more is a drag (rotating the globe), not a click. */
export function Picker({ sources }: { sources: React.RefObject<(PickSource | undefined)[]> }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const select = useExplorer((s) => s.select);

  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    let lastHover = 0;
    let hovering = false;
    const pick = (e: PointerEvent, radius: number) => {
      const r = el.getBoundingClientRect();
      return pickObject(sources.current ?? [], simClock.now(), camera, e.clientX - r.left, e.clientY - r.top, r.width, r.height, radius);
    };
    const setHover = (on: boolean) => {
      if (on === hovering) return;
      hovering = on;
      el.style.cursor = on ? "pointer" : "";
    };
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved >= CLICK_SLOP_PX) return;
      const id = pick(e, e.pointerType === "touch" ? 16 : 8);
      if (id !== null) select(id);
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons || e.pointerType === "touch") return;
      const now = performance.now();
      if (now - lastHover < HOVER_EVERY_MS) return;
      lastHover = now;
      setHover(pick(e, 8) !== null);
    };
    const onLeave = () => setHover(false);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.style.cursor = "";
    };
  }, [gl, camera, select, sources]);

  return null;
}

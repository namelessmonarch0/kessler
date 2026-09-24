"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { simClock } from "@/lib/clock";
import { behindEarth, isOccluded, LABEL_INTERVAL_MS, labelAnchor, labelsActive, pickLabels, type Candidate, type VisibleRect } from "@/lib/labels";
import { nameCache } from "@/lib/names";
import { useExplorer } from "@/lib/store";
import { GLOBE_COLORS } from "@/lib/types";
import { interpolate } from "@/components/globe/instances";
import type { LabelSource } from "@/components/globe/Objects";

type Shown = { el: HTMLButtonElement; src: LabelSource; i: number };

/** The part of the screen labels may use: between the top bar and the sheet in the bottom-sheet
 * layout; on desktop, the gap between the two panel columns (measured from the visible panels,
 * so a hidden column frees its side). */
function visibleRect(sheetLayout: boolean, width: number, height: number): VisibleRect {
  if (sheetLayout) {
    const s = useExplorer.getState();
    return { left: 0, top: s.topBarBottom ?? 0, right: width, bottom: s.mobileSheetTop ?? height };
  }
  let left = 0, right = width;
  document.querySelectorAll('[data-col="left"] [data-panel]').forEach((e) => (left = Math.max(left, e.getBoundingClientRect().right)));
  document.querySelectorAll('[data-col="right"] [data-panel]').forEach((e) => (right = Math.min(right, e.getBoundingClientRect().left)));
  return { left, top: 0, right, bottom: height };
}

/**
 * Two cadences:
 * - every 250 ms: decide WHICH objects get labels (≤ 12; the expensive pass over every record);
 * - every frame: re-project just those ≤ 12 and move their buttons, so labels stay attached to
 *   their objects while the camera or the objects move.
 * Buttons are reused per object id — only created/removed when the chosen set changes — so a
 * click that lands between two selection passes still hits the same element.
 */
export function LabelDriver({
  sources,
  container,
  sheetLayout,
}: {
  sources: React.RefObject<(LabelSource | undefined)[]>;
  container: React.RefObject<HTMLDivElement | null>;
  sheetLayout: boolean;
}) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const last = useRef(0);
  const active = useRef(false);
  const shown = useRef(new Map<number, Shown>());
  const scratch = useRef(new THREE.Vector3());
  const rect = useRef<VisibleRect>({ left: 0, top: 0, right: 0, bottom: 0 });

  const clear = (el: HTMLDivElement) => {
    if (shown.current.size === 0) return;
    el.replaceChildren();
    shown.current.clear();
  };

  const reselect = (el: HTMLDivElement) => {
    active.current = labelsActive(active.current, camera.position.length());
    // `setAttribute` rather than `el.dataset.x = …`: eslint-plugin-react-hooks' immutability rule
    // flags assignments through a ref-provided DOM node; behaviour is identical.
    el.setAttribute("data-active", active.current ? "1" : "0");
    if (!active.current) {
      // Zoomed back out: drop the (now invisible) labels so none stay clickable.
      clear(el);
      return;
    }

    const cam: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
    const t = simClock.now();
    const cands: Candidate[] = [];
    const where = new Map<number, { src: LabelSource; i: number }>();
    for (const src of sources.current ?? []) {
      if (!src) continue;
      const names = nameCache.peek(src.group);
      if (!names) {
        void nameCache.get(src.group);
        continue;
      }
      src.records.forEach((r, i) => {
        if (!src.visible[i]) return;
        const name = names.get(r.noradId);
        if (!name) return;
        const p = scratch.current;
        if (!interpolate(src.frames.current, t, i, p)) return;
        const pos: [number, number, number] = [p.x, p.y, p.z];
        // Cheap conservative reject before the costlier ray-sphere solve and matrix projection —
        // see behindEarth's doc comment in @/lib/labels for why this is sound.
        if (behindEarth(cam, pos)) return;
        const occluded = isOccluded(cam, pos);
        p.project(camera);
        if (p.z > 1) return;
        where.set(r.noradId, { src, i });
        cands.push({ id: r.noradId, name, color: GLOBE_COLORS[r.type], occluded, x: ((p.x + 1) / 2) * size.width, y: ((1 - p.y) / 2) * size.height });
      });
    }
    rect.current = visibleRect(sheetLayout, size.width, size.height);
    const placed = pickLabels(cands, { width: size.width, height: size.height, selectedId: useExplorer.getState().selectedId, rect: rect.current });

    const keep = new Set(placed.map((p) => p.id));
    for (const [id, s] of shown.current) {
      if (!keep.has(id)) {
        s.el.remove();
        shown.current.delete(id);
      }
    }
    for (const p of placed) {
      let s = shown.current.get(p.id);
      if (!s) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "globe-label";
        b.tabIndex = -1;
        const id = p.id;
        b.onclick = () => useExplorer.getState().select(id);
        el.appendChild(b);
        s = { el: b, ...where.get(p.id)! };
        shown.current.set(p.id, s);
      } else {
        Object.assign(s, where.get(p.id)!);
      }
      if (s.el.textContent !== p.name) s.el.textContent = p.name;
      s.el.style.color = p.color;
      s.el.style.left = `${Math.round(p.left)}px`;
      s.el.style.top = `${Math.round(p.top)}px`;
      s.el.style.display = "";
    }
  };

  // Moves the chosen labels to where their objects are THIS frame; hides one whose object has
  // slipped behind the Earth or out of the visible rect until the next selection pass decides.
  const reproject = () => {
    const cam: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
    const t = simClock.now();
    const p = scratch.current;
    for (const s of shown.current.values()) {
      let visible = interpolate(s.src.frames.current, t, s.i, p);
      if (visible) {
        const pos: [number, number, number] = [p.x, p.y, p.z];
        visible = !behindEarth(cam, pos) && !isOccluded(cam, pos);
      }
      if (visible) {
        p.project(camera);
        visible = p.z <= 1;
      }
      if (!visible) {
        if (s.el.style.display !== "none") s.el.style.display = "none";
        continue;
      }
      // Whole pixels: crisp text, and no style write (or layout) on frames where the object moved
      // less than a pixel.
      const x = ((p.x + 1) / 2) * size.width, y = ((1 - p.y) / 2) * size.height;
      const r = rect.current;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) {
        if (s.el.style.display !== "none") s.el.style.display = "none";
        continue;
      }
      const { left, top } = labelAnchor(x, y);
      const l = `${Math.round(left)}px`, tp = `${Math.round(top)}px`;
      if (s.el.style.left !== l) s.el.style.left = l;
      if (s.el.style.top !== tp) s.el.style.top = tp;
      if (s.el.style.display) s.el.style.display = "";
    }
  };

  useFrame(() => {
    const el = container.current;
    if (!el) return;
    const now = performance.now();
    if (now - last.current >= LABEL_INTERVAL_MS) {
      last.current = now;
      reselect(el);
    }
    if (active.current && shown.current.size) reproject();
  });
  return null;
}

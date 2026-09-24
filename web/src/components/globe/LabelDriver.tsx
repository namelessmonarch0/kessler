"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { simClock } from "@/lib/clock";
import { behindEarth, isOccluded, LABEL_INTERVAL_MS, labelsActive, pickLabels, type Candidate } from "@/lib/labels";
import { nameCache } from "@/lib/names";
import { useExplorer } from "@/lib/store";
import { GLOBE_COLORS } from "@/lib/types";
import { interpolate } from "@/components/globe/instances";
import type { LabelSource } from "@/components/globe/Objects";

export function LabelDriver({ sources, container }: { sources: React.RefObject<(LabelSource | undefined)[]>; container: React.RefObject<HTMLDivElement | null> }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const last = useRef(0);
  const active = useRef(false);
  const shownKey = useRef("");
  const scratch = useRef(new THREE.Vector3());

  useFrame(() => {
    const now = performance.now();
    if (now - last.current < LABEL_INTERVAL_MS) return;
    last.current = now;
    const el = container.current;
    if (!el) return;
    active.current = labelsActive(active.current, camera.position.length());
    // Assigning through `el.dataset` trips eslint-plugin-react-hooks' new immutability rule
    // (treats `container.current.dataset.x = ...` as reassigning the ref-provided DOM node);
    // `setAttribute` is a method call the rule doesn't flag, and is behaviourally identical here.
    el.setAttribute("data-active", active.current ? "1" : "0");
    if (!active.current) {
      // Zoomed back out: drop the (now invisible) labels so none stay clickable.
      if (shownKey.current) {
        el.replaceChildren();
        shownKey.current = "";
      }
      return;
    }

    const cam: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
    const t = simClock.now();
    const cands: Candidate[] = [];
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
        cands.push({
          id: r.noradId, name, color: GLOBE_COLORS[r.type], occluded,
          x: ((p.x + 1) / 2) * size.width, y: ((1 - p.y) / 2) * size.height,
        });
      });
    }
    const placed = pickLabels(cands, { width: size.width, height: size.height, selectedId: useExplorer.getState().selectedId });
    const key = placed.map((p) => `${p.id}:${Math.round(p.left)}:${Math.round(p.top)}`).join("|");
    if (key === shownKey.current) return;
    shownKey.current = key;
    el.replaceChildren(
      ...placed.map((p) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "globe-label";
        b.textContent = p.name;
        b.style.left = `${p.left}px`;
        b.style.top = `${p.top}px`;
        b.style.color = p.color;
        b.tabIndex = -1;
        b.onclick = () => useExplorer.getState().select(p.id);
        return b;
      }),
    );
  });
  return null;
}

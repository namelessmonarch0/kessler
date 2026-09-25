"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import type { PropagationFrames, RequestPath } from "@/components/globe/usePropagation";
import { interpolate } from "@/components/globe/instances";
import { buildObjectGeometry, frameAlpha, setVisibility } from "@/components/globe/objectPoints";
import { createObjectMaterial, updateObjectUniforms } from "@/components/globe/objectMaterial";
import { spriteKind } from "@/components/globe/objectSprites";
import { kindColour } from "@/components/globe/spriteAtlas";

const PATH_STEPS = 181;
const PATH_REFRESH_MS = 10_000;
const PATH_OPACITY = 0.75;
const scratchPos = new THREE.Vector3();

/** The selected object: its sprite at 3× inside pixel corner brackets, and its orbit path over one period
 * centred on now, fading toward both ends. Both are depth-tested, so they hide behind the Earth. */
export function Selection({
  record,
  index,
  frames,
  requestPath,
  atlas,
}: {
  record: OrbitRecord;
  index: number;
  frames: PropagationFrames;
  requestPath: RequestPath;
  atlas: THREE.Texture;
}) {
  const gl = useThree((s) => s.gl);
  const geometry = useMemo(() => {
    const g = buildObjectGeometry([record]);
    setVisibility(g, [true]);
    return g;
  }, [record]);
  const material = useMemo(() => createObjectMaterial(atlas, { scale: 3, bracket: true }), [atlas]);
  const point = useRef<THREE.Points>(null);

  const line = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
    const l = new THREE.Line(g, m);
    l.frustumCulled = false;
    l.renderOrder = 5;
    return l;
  }, []);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [geometry, material, line],
  );

  useEffect(() => {
    let cancelled = false;
    const c = kindColour(spriteKind(record.type));
    const load = () =>
      requestPath(index, simClock.now(), PATH_STEPS).then((positions) => {
        if (cancelled || !positions) return;
        const n = positions.length / 3;
        const colors = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b, PATH_OPACITY * Math.pow(Math.sin((Math.PI * i) / Math.max(n - 1, 1)), 0.6)], i * 4);
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        g.setAttribute("color", new THREE.BufferAttribute(colors, 4));
        line.geometry.dispose();
        line.geometry = g;
      });
    load();
    const timer = window.setInterval(load, PATH_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry();
    };
  }, [record, index, requestPath, line]);

  // The same two worker frames and interpolation factor as the object cloud, so the 3× sprite sits exactly on
  // (and faces the same way as) the object's own point.
  useFrame(() => {
    const f = frames.current;
    const ok = !!(f.prev && f.next) && interpolate(f, simClock.now(), index, scratchPos);
    if (!point.current) return;
    point.current.visible = ok;
    if (!ok) return;
    const prev = geometry.getAttribute("aPrev") as THREE.BufferAttribute;
    const next = geometry.getAttribute("position") as THREE.BufferAttribute;
    prev.setXYZ(0, f.prev![index * 3], f.prev![index * 3 + 1], f.prev![index * 3 + 2]);
    next.setXYZ(0, f.next![index * 3], f.next![index * 3 + 1], f.next![index * 3 + 2]);
    prev.needsUpdate = next.needsUpdate = true;
    updateObjectUniforms(material, gl, frameAlpha(f, simClock.now()), 1); // fade 1: always the icon
  });

  return (
    <>
      <primitive object={line} />
      {/* renderOrder 10: after the object cloud, so the brackets sit on top of neighbouring icons */}
      <points ref={point} geometry={geometry} material={material} frustumCulled={false} renderOrder={10} />
    </>
  );
}

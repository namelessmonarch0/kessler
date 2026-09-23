"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { feature } from "topojson-client";
import type { FeatureCollection } from "geojson";
import type { Topology } from "topojson-specification";
import { simClock } from "@/lib/clock";
import { sunDirectionScene } from "@/lib/sun";
import { drawEarthTexture } from "@/components/globe/earthTexture";
import { createEarthMaterial } from "@/components/globe/earthMaterial";

export function Earth() {
  const { canvas, texture, material } = useMemo(() => {
    const small = typeof window !== "undefined" && window.innerWidth < 700;
    const canvas = document.createElement("canvas");
    canvas.width = small ? 2048 : 4096;
    canvas.height = canvas.width / 2;
    drawEarthTexture(canvas.getContext("2d")!, null, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return { canvas, texture, material: createEarthMaterial(texture) };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/geo/land-50m.json")
      .then((r) => r.json())
      .then((topo: Topology) => {
        if (cancelled) return;
        const land = feature(topo, topo.objects.land) as unknown as FeatureCollection;
        drawEarthTexture(canvas.getContext("2d")!, land, canvas.width, canvas.height);
        texture.needsUpdate = true;
      })
      .catch(() => undefined); // ocean-only Earth is an acceptable fallback
    return () => {
      cancelled = true;
      texture.dispose();
      material.dispose();
    };
  }, [canvas, texture, material]);

  useFrame(() => {
    const [x, y, z] = sunDirectionScene(new Date(simClock.now()));
    (material.uniforms.sunDir.value as THREE.Vector3).set(x, y, z);
  });

  return (
    <group>
      {/* R3F only raycasts objects that have at least one pointer handler; without one here the
          Earth is invisible to picking, so a click on the near side of the globe falls straight
          through to whatever instanced object happens to sit behind it on the far side. Adding
          handlers makes the Earth participate (as the nearest hit for any click on its visible
          surface) and stopPropagation keeps that hit from also reaching objects further away. */}
      <mesh
        material={material}
        onClick={(e) => e.stopPropagation()}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "";
        }}
        onPointerOut={(e) => e.stopPropagation()}
      >
        <sphereGeometry args={[1, 128, 96]} />
      </mesh>
      {/* ink outline (inverted hull) */}
      <mesh>
        <sphereGeometry args={[1.012, 96, 64]} />
        <meshBasicMaterial color="#0a0f1a" side={THREE.BackSide} />
      </mesh>
      {/* soft cartoon atmosphere rim */}
      <mesh>
        <sphereGeometry args={[1.045, 96, 64]} />
        <meshBasicMaterial color="#7fb6ff" transparent opacity={0.08} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

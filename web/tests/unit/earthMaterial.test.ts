import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createEarthMaterial } from "@/components/globe/earthMaterial";

describe("earth material", () => {
  it("keeps the twilight band and adds a subtle surface grain", () => {
    const m = createEarthMaterial(new THREE.Texture());
    expect(m.uniforms.band.value).toBeCloseTo(0.1564, 4);
    expect(m.uniforms.grain.value).toBeCloseTo(0.04, 5);
    expect(m.fragmentShader).toContain("grain");
  });
});

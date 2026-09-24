import * as THREE from "three";

// ±9° twilight band: sin(9°) ≈ 0.1564. Inside the band a 4×4 Bayer ordered dither thickens
// towards night while a soft tint builds underneath (spec §6.2). The Earth surface also carries
// a subtle ordered-dither grain (±4% brightness) — the only dither left now that the full-frame
// post-process effect is gone; orbital objects stay crisp.
const vertexShader = /* glsl */ `
varying vec3 vNormalW;
varying vec2 vUv;
void main() {
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D map;
uniform vec3 sunDir;
uniform float band;
uniform float cellSize;
uniform float grain;
varying vec3 vNormalW;
varying vec2 vUv;

float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[x + y * 4]) + 0.5) / 16.0;
}

void main() {
  vec3 base = texture2D(map, vUv).rgb;
  // Subtle ordered-dither texture on the Earth only (objects stay crisp): ±grain brightness.
  base *= 1.0 + grain * 2.0 * (bayer4(floor(gl_FragCoord.xy / cellSize)) - 0.5);
  float d = dot(normalize(vNormalW), normalize(sunDir));
  float t = smoothstep(band, -band, d);                 // 0 = day, 1 = night
  float dithered = step(bayer4(floor(gl_FragCoord.xy / cellSize)), t);
  vec3 night = base * 0.16 + vec3(0.004, 0.008, 0.02);
  gl_FragColor = vec4(mix(base, night, clamp(0.5 * t + 0.5 * dithered, 0.0, 1.0)), 1.0);
  #include <colorspace_fragment>
}`;

export function createEarthMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      band: { value: 0.1564 },
      cellSize: { value: 2 * (typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio, 2)) },
      grain: { value: 0.04 },
    },
    vertexShader,
    fragmentShader,
  });
}

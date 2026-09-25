import * as THREE from "three";
import { ATLAS_CELL, SECTORS, SPRITE_COUNT } from "@/components/globe/spriteAtlas";

/** Empty sprite pixels between the selection's 3× icon and its corner brackets. */
export const BRACKET_MARGIN = 4;
const BRACKET_ARM = 6;

// Every object is one point. The GPU interpolates between the two latest worker frames ("aPrev" → "position")
// with uAlpha, picks one of 8 screen directions from the projected velocity, and draws either a dot or the
// sprite for that direction at a fixed size in whole device pixels per sprite pixel (uArtPx), with the point's
// centre snapped to the pixel grid so icons stay crisp as they move. Which objects are icons is fixed per object
// (a hash of its index) and grows with uFade as the Earth gets larger on screen.
const vertexShader = /* glsl */ `
attribute vec3 aPrev;
attribute float aSprite;
attribute float aDot;
attribute vec3 aColor;
attribute float aVisible;
uniform float uAlpha;
uniform float uFade;
uniform float uArtPx;
uniform float uScale;
uniform float uBracket;
uniform vec2 uViewport;
flat varying float vSprite;
flat varying float vSector;
flat varying float vIcon;
flat varying float vSizePx;
flat varying vec3 vColor;

float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }

void main() {
  vec3 p = mix(aPrev, position, uAlpha);
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  // Failed propagations are NaN; comparisons with NaN are false, so they fail this finite-range check too.
  bool finite = abs(p.x) < 1.0e4 && abs(p.y) < 1.0e4 && abs(p.z) < 1.0e4;
  if (aVisible < 0.5 || !finite || clip.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  vec4 ahead = projectionMatrix * modelViewMatrix * vec4(p + (position - aPrev), 1.0);
  vec2 d = (ahead.xy / ahead.w - clip.xy / clip.w) * uViewport;
  vSector = dot(d, d) > 1.0e-12 ? mod(floor(atan(d.y, d.x) / 0.78539816 + 0.5), 8.0) : 0.0;

  vIcon = uFade >= 1.0 || hash(float(gl_VertexID)) < uFade ? 1.0 : 0.0;
  float margin = uBracket > 0.5 ? ${BRACKET_MARGIN.toFixed(1)} : 0.0;
  vSizePx = vIcon > 0.5 ? (${ATLAS_CELL.toFixed(1)} * uScale + 2.0 * margin) * uArtPx : aDot * uArtPx;

  vec2 px = (clip.xy / clip.w * 0.5 + 0.5) * uViewport;
  px = mod(vSizePx, 2.0) < 0.5 ? floor(px + 0.5) : floor(px) + 0.5;
  clip.xy = (px / uViewport * 2.0 - 1.0) * clip.w;
  gl_Position = clip;
  gl_PointSize = vSizePx;
  vSprite = aSprite;
  vColor = aColor;
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uArtPx;
uniform float uScale;
uniform float uBracket;
uniform vec3 uBracketColor;
flat varying float vSprite;
flat varying float vSector;
flat varying float vIcon;
flat varying float vSizePx;
flat varying vec3 vColor;

bool isBracket(vec2 a, float span) {
  bool edgeX = a.x < 1.0 || a.x >= span - 1.0;
  bool edgeY = a.y < 1.0 || a.y >= span - 1.0;
  bool nearX = a.x < ${BRACKET_ARM.toFixed(1)} || a.x >= span - ${BRACKET_ARM.toFixed(1)};
  bool nearY = a.y < ${BRACKET_ARM.toFixed(1)} || a.y >= span - ${BRACKET_ARM.toFixed(1)};
  return (edgeX && nearY) || (edgeY && nearX);
}

void main() {
  vec4 col = vec4(vColor, 1.0);
  if (vIcon > 0.5) {
    vec2 art = floor(gl_PointCoord * vSizePx / uArtPx); // sprite-pixel coordinates within the point, y down
    float margin = uBracket > 0.5 ? ${BRACKET_MARGIN.toFixed(1)} : 0.0;
    float span = ${ATLAS_CELL.toFixed(1)} * uScale + 2.0 * margin;
    if (uBracket > 0.5 && isBracket(art, span)) {
      col = vec4(uBracketColor, 1.0);
    } else {
      vec2 cell = floor((art - margin) / uScale);
      if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, vec2(${ATLAS_CELL.toFixed(1)})))) discard;
      vec2 uv = (vec2(vSector, vSprite) * ${ATLAS_CELL.toFixed(1)} + cell + 0.5)
        / vec2(${(SECTORS * ATLAS_CELL).toFixed(1)}, ${(SPRITE_COUNT * ATLAS_CELL).toFixed(1)});
      col = texture2D(uAtlas, uv);
      if (col.a < 0.5) discard;
    }
  }
  gl_FragColor = col;
  #include <colorspace_fragment>
}`;

/** Whole device pixels per sprite pixel: crisp on 1×, 2× and 3× screens (fractional ratios round). */
export const artPixels = (devicePixelRatio: number) => Math.max(1, Math.round(devicePixelRatio));

/** Per-frame uniforms: interpolation factor, dot→icon fade, device pixels per sprite pixel, and the viewport. */
export function updateObjectUniforms(m: THREE.ShaderMaterial, gl: THREE.WebGLRenderer, alpha: number, fade: number): void {
  const u = m.uniforms;
  u.uAlpha.value = alpha;
  u.uFade.value = fade;
  u.uArtPx.value = artPixels(gl.getPixelRatio());
  gl.getDrawingBufferSize(u.uViewport.value);
}

export function createObjectMaterial(atlas: THREE.Texture, opts: { scale?: number; bracket?: boolean } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas },
      uAlpha: { value: 1 },
      uFade: { value: 0 },
      uArtPx: { value: 1 },
      uScale: { value: opts.scale ?? 1 },
      uBracket: { value: opts.bracket ? 1 : 0 },
      uBracketColor: { value: new THREE.Color("#c9c8c2") },
      uViewport: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader,
    fragmentShader,
    depthTest: true,
    depthWrite: false,
  });
}

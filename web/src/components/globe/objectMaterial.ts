import * as THREE from "three";
import { ATLAS_CELL, SECTORS, SPRITE_COUNT } from "@/components/globe/spriteAtlas";

/** Selection brackets, in CSS px: gap around the sprite, line thickness, and arm length. */
const BRACKET_MARGIN = 5;
const BRACKET_THICK = 2;
const BRACKET_ARM = 10;

const f = (n: number) => n.toFixed(1);

// Every object is one point. The GPU interpolates between the two latest worker frames ("aPrev" → "position")
// with uAlpha, picks one of 8 screen directions from the projected velocity, and draws either a dot or the
// sprite for that direction. Sprites scale smoothly (uArt CSS px per sprite pixel, any real number); sampling is
// "sharp bilinear" — each sprite pixel stays a solid block and only the one-device-pixel seam between two
// sprite pixels blends — so fractional scales neither blur nor show uneven 2 px / 3 px pixel columns. Which
// objects are icons is fixed per object (a hash of its index) and grows with uFade.
const vertexShader = /* glsl */ `
attribute vec3 aPrev;
attribute float aSprite;
attribute float aDot;
attribute vec3 aColor;
attribute float aVisible;
uniform float uAlpha;
uniform float uFade;
uniform float uArt;
uniform float uDot;
uniform float uDpr;
uniform float uScale;
uniform float uBracket;
uniform vec2 uViewport;
flat varying float vSprite;
flat varying float vSector;
flat varying float vIcon;
flat varying float vSizeCss;
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
  float margin = uBracket > 0.5 ? ${f(BRACKET_MARGIN)} : 0.0;
  float css = vIcon > 0.5 ? ${f(ATLAS_CELL)} * uArt * uScale + 2.0 * margin : aDot * uDot;
  float sizePx = max(1.0, floor(css * uDpr + 0.5));
  vSizeCss = sizePx / uDpr;

  // Snap the point to the pixel grid (whole-pixel centre for even sizes, half-pixel for odd) so it doesn't shimmer.
  vec2 px = (clip.xy / clip.w * 0.5 + 0.5) * uViewport;
  px = mod(sizePx, 2.0) < 0.5 ? floor(px + 0.5) : floor(px) + 0.5;
  clip.xy = (px / uViewport * 2.0 - 1.0) * clip.w;
  gl_Position = clip;
  gl_PointSize = sizePx;
  vSprite = aSprite;
  vColor = aColor;
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uArt;
uniform float uDpr;
uniform float uScale;
uniform float uBracket;
uniform vec3 uBracketColor;
flat varying float vSprite;
flat varying float vSector;
flat varying float vIcon;
flat varying float vSizeCss;
flat varying vec3 vColor;

void main() {
  vec4 col = vec4(vColor, 1.0);
  if (vIcon > 0.5) {
    vec2 q = (gl_PointCoord - 0.5) * vSizeCss; // CSS px from the point's centre, y down
    float spritePx = uArt * uScale;             // CSS px per sprite pixel
    float halfBox = ${f(ATLAS_CELL / 2)} * spritePx + ${f(BRACKET_MARGIN)};
    vec2 a = abs(q);
    bool bracket = uBracket > 0.5 && (
      (a.x > halfBox - ${f(BRACKET_THICK)} && a.y > halfBox - ${f(BRACKET_ARM)}) ||
      (a.y > halfBox - ${f(BRACKET_THICK)} && a.x > halfBox - ${f(BRACKET_ARM)}));
    if (bracket) {
      col = vec4(uBracketColor, 1.0);
    } else {
      vec2 t = q / spritePx + ${f(ATLAS_CELL / 2)}; // continuous sprite-pixel coordinates in the cell
      if (any(lessThan(t, vec2(0.0))) || any(greaterThanEqual(t, vec2(${f(ATLAS_CELL)})))) discard;
      // Sharp bilinear: stay on the texel centre except within half a device pixel of a texel edge.
      float k = spritePx * uDpr;                 // device px per sprite pixel
      vec2 fr = fract(t) - 0.5;
      float region = max(0.5 - 0.5 / k, 0.0);
      vec2 texel = floor(t) + (fr - clamp(fr, -region, region)) * k + 0.5;
      texel = clamp(texel, vec2(0.5), vec2(${f(ATLAS_CELL - 0.5)}));
      vec2 uv = (vec2(vSector, vSprite) * ${f(ATLAS_CELL)} + texel)
        / vec2(${f(SECTORS * ATLAS_CELL)}, ${f(SPRITE_COUNT * ATLAS_CELL)});
      col = texture2D(uAtlas, uv);
      if (col.a < 0.5) discard;
      col = vec4(col.rgb / col.a, 1.0); // empty texels are transparent black: undo their darkening at shape edges
    }
  }
  gl_FragColor = col;
  #include <colorspace_fragment>
}`;

/** Per-frame uniforms: interpolation factor, dot→icon fade, CSS px per sprite pixel, dot scale, and the viewport. */
export function updateObjectUniforms(
  m: THREE.ShaderMaterial,
  gl: THREE.WebGLRenderer,
  frame: { alpha: number; fade: number; art: number; dot: number; scale?: number },
): void {
  const u = m.uniforms;
  u.uAlpha.value = frame.alpha;
  u.uFade.value = frame.fade;
  u.uArt.value = frame.art;
  u.uDot.value = frame.dot;
  if (frame.scale !== undefined) u.uScale.value = frame.scale;
  u.uDpr.value = gl.getPixelRatio();
  gl.getDrawingBufferSize(u.uViewport.value);
}

export function createObjectMaterial(atlas: THREE.Texture, opts: { bracket?: boolean } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas },
      uAlpha: { value: 1 },
      uFade: { value: 0 },
      uArt: { value: 1.5 },
      uDot: { value: 1 },
      uDpr: { value: 1 },
      uScale: { value: 1 },
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

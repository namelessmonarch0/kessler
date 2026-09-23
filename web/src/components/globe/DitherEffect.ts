import { Effect, EffectAttribute } from "postprocessing";
import { Uniform } from "three";

// Subtle ordered dither + grain (spec §6.2: cell 2 px, 7 levels, grain 0.09). Quantisation
// happens in display (sRGB-like) space; grain is multiplicative so black space stays black.
const fragmentShader = /* glsl */ `
uniform float cell;
uniform float levels;
uniform float grain;

float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[x + y * 4]) + 0.5) / 16.0;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 frag = uv * resolution;
  vec2 cellId = floor(frag / cell);
  vec3 c = texture2D(inputBuffer, (cellId * cell + cell * 0.5) / resolution).rgb;
  vec3 display = pow(max(c, 0.0), vec3(1.0 / 2.2));
  float L = levels - 1.0;
  vec3 q = floor(display * L + bayer4(cellId)) / L;
  float g = vnoise(frag * 0.9) * 0.55 + hash(frag) * 0.45;
  q *= 1.0 + (g - 0.5) * grain * 2.0;
  outputColor = vec4(pow(clamp(q, 0.0, 1.0), vec3(2.2)), inputColor.a);
}`;

export class DitherEffectImpl extends Effect {
  constructor({ cell = 2, levels = 7, grain = 0.09 } = {}) {
    super("DitherEffect", fragmentShader, {
      // Samples the input at the cell centre (not just the current pixel).
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, Uniform>([
        ["cell", new Uniform(cell)],
        ["levels", new Uniform(levels)],
        ["grain", new Uniform(grain)],
      ]),
    });
  }
}

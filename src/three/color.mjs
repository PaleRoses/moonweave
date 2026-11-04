import {OKLAB_MATRICES} from '../core/color.mts';

// GLSL uses the same coefficients as CPU sampling; mat3 constructors take columns.
const literal = value => Number.isInteger(value) ? `${value}.0` : String(value);
const matrix = rows => `mat3(${[0, 1, 2].flatMap(column => rows.map(row => literal(row[column]))).join(', ')})`;

export const COLOR_GLSL = /* glsl */`
vec3 mwLinearToOklab(vec3 color) {
  vec3 lms = ${matrix(OKLAB_MATRICES.rgbToLms)} * color;
  vec3 roots = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
  return ${matrix(OKLAB_MATRICES.lmsToLab)} * roots;
}

vec3 mwOklabToLinear(vec3 color) {
  vec3 roots = ${matrix(OKLAB_MATRICES.labToLms)} * color;
  return ${matrix(OKLAB_MATRICES.lmsToRgb)} * (roots * roots * roots);
}

vec3 mwColorMixOklab(vec3 a, vec3 b, float mask) {
  if (mask <= 0.0) return a;
  if (mask >= 1.0) return b;
  return mwOklabToLinear(mix(mwLinearToOklab(a), mwLinearToOklab(b), mask));
}
`;

export const COLOR_ADJUST_GLSL = /* glsl */`
vec3 mwColorAdjust(vec3 inputColor, float lightness, float chroma, float hue) {
  vec3 lab = mwLinearToOklab(inputColor);
  float degrees = hue - 360.0 * floor((hue + 180.0) / 360.0);
  float angle = degrees * 0.017453292519943295;
  float c = cos(angle), s = sin(angle);
  vec2 rotated = vec2(c * lab.y - s * lab.z, s * lab.y + c * lab.z);
  return mwOklabToLinear(vec3(lab.x + lightness, chroma * rotated));
}
`;

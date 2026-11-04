import type {ColorSpace, ColorInterpolation, Vec3} from './algebra.mts';
import type {ColorSample, ScalarSample} from './field-evaluate.mts';
import {OKLAB_MATRICES, multiplyColorMatrix, hueRadians} from './color.mts';

const components = (value: (index: 0 | 1 | 2) => number): Vec3 => [value(0), value(1), value(2)];

/** Convert a color and both tangents through the same Oklab coordinate map. */
function inOklab(sample: ColorSample): ColorSample {
  const lms = multiplyColorMatrix(OKLAB_MATRICES.rgbToLms, sample.value);
  const roots = components(i => Math.cbrt(lms[i]));
  const tangent = (delta: Vec3): Vec3 => {
    const dlms = multiplyColorMatrix(OKLAB_MATRICES.rgbToLms, delta);
    return multiplyColorMatrix(OKLAB_MATRICES.lmsToLab, components(i => {
      if (roots[i] !== 0) return dlms[i] / (3 * roots[i] * roots[i]);
      // The cube-root map has no finite Jacobian here. A zero input tangent
      // uses the documented zero convention; first-order data cannot describe
      // the input's higher-order behavior at this singularity.
      if (dlms[i] === 0) return 0;
      throw new RangeError('Oklab color derivative is undefined at a zero LMS component with a nonzero tangent.');
    }));
  };
  return {value: multiplyColorMatrix(OKLAB_MATRICES.lmsToLab, roots), dx: tangent(sample.dx), dy: tangent(sample.dy)};
}

function inLinearRgb(sample: ColorSample): ColorSample {
  const roots = multiplyColorMatrix(OKLAB_MATRICES.labToLms, sample.value);
  const tangent = (delta: Vec3): Vec3 => {
    const dRoots = multiplyColorMatrix(OKLAB_MATRICES.labToLms, delta);
    return multiplyColorMatrix(OKLAB_MATRICES.lmsToRgb,
      components(i => 3 * roots[i] * roots[i] * dRoots[i]));
  };
  return {
    value: multiplyColorMatrix(OKLAB_MATRICES.lmsToRgb, components(i => roots[i] * roots[i] * roots[i])),
    dx: tangent(sample.dx), dy: tangent(sample.dy),
  };
}

/** Oklab lightness translation and signed chroma rotation/scale, with the full
 * product rule for spatially varying controls. Hue is in degrees. Keeping a,b
 * Cartesian preserves neutral colors without extracting an undefined hue.
 */
export function adjustColorSample(
  input: ColorSample, lightness: ScalarSample, chroma: ScalarSample, hue: ScalarSample,
): ColorSample {
  const sample = inOklab(input), angle = hueRadians(hue.value);
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const a = cosine * sample.value[1] - sine * sample.value[2];
  const b = sine * sample.value[1] + cosine * sample.value[2];
  const tangent = (delta: Vec3, dl: number, dc: number, dh: number): Vec3 => {
    const rotation = dh * (Math.PI / 180), scale = chroma.value;
    return [
      delta[0] + dl,
      dc * a + scale * (cosine * delta[1] - sine * delta[2] - rotation * b),
      dc * b + scale * (sine * delta[1] + cosine * delta[2] + rotation * a),
    ];
  };
  return inLinearRgb({
    value: [sample.value[0] + lightness.value, chroma.value * a, chroma.value * b],
    dx: tangent(sample.dx, lightness.dx, chroma.dx, hue.dx),
    dy: tangent(sample.dy, lightness.dy, chroma.dy, hue.dy),
  });
}

/**
 * Clamped pointwise interpolation, including both input tangents and the mask
 * product rule. Color coordinates remain extended-range until a material uses
 * them as reflectance. Endpoints return the selected sample without conversion.
 */
export function mixColorSamples(
  a: ColorSample, b: ColorSample, mask: ScalarSample, space: ColorSpace = 'linear-rgb',
): ColorSample {
  const weight = Math.max(0, Math.min(1, mask.value));
  if (weight === 0 || a === b) return a;
  if (weight === 1) return b;
  const first = space === 'oklab' ? inOklab(a) : a;
  const second = space === 'oklab' ? inOklab(b) : b;
  const tangent = (ad: Vec3, bd: Vec3, md: number): Vec3 => components(i =>
    (1 - weight) * ad[i] + weight * bd[i] + (second.value[i] - first.value[i]) * md);
  const sample = {
    value: components(i => first.value[i] + (second.value[i] - first.value[i]) * weight),
    dx: tangent(first.dx, second.dx, mask.dx),
    dy: tangent(first.dy, second.dy, mask.dy),
  };
  return space === 'oklab' ? inLinearRgb(sample) : sample;
}

export interface RampInterval {
  readonly a: number;
  readonly b: number;
  readonly weight: number;
  /** Derivative of weight with respect to the input scalar. */
  readonly derivative: number;
}

/**
 * Positions are already validated by the grammar. Select only the active color
 * interval. Exact knots use the authored color and its tangents, with zero
 * input-derived tangent; constant ramps are right-continuous at each knot.
 */
export function rampInterval(
  value: number, positions: readonly number[], interpolation: ColorInterpolation,
): RampInterval {
  const last = positions.length - 1;
  const selected = (index: number): RampInterval => ({a: index, b: index, weight: 0, derivative: 0});
  if (value <= positions[0]) return selected(0);
  if (value >= positions[last]) return selected(last);
  let low = 0, high = last;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (value < positions[middle]) high = middle;
    else low = middle;
  }
  if (value === positions[low] || interpolation === 'constant') return selected(low);
  const span = positions[high] - positions[low], t = (value - positions[low]) / span;
  return interpolation === 'smoothstep'
    ? {a: low, b: high, weight: t * t * (3 - 2 * t), derivative: 6 * t * (1 - t) / span}
    : {a: low, b: high, weight: t, derivative: 1 / span};
}

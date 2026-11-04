import test from 'node:test';
import assert from 'node:assert/strict';
import {linearToOklab, oklabToLinear} from '../src/core/color.mts';
import {mixColorSamples, rampInterval} from '../src/core/color-sample.mts';

const zero = [0, 0, 0];
const sample = (value, dx = zero, dy = zero) => ({value, dx, dy});
const mask = (value, dx = 0, dy = 0) => ({value, dx, dy});
const close = (actual, expected, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
const closeVector = (actual, expected, tolerance) => actual.forEach((value, i) => close(value, expected[i], tolerance));

test('Oklab conversion matches published XYZ reference pairs and preserves extended-range round trips', () => {
  // Ottosson's published XYZ/Lab reference table is rounded to three decimals.
  // This independent XYZ->RGB path also checks the fused RGB/LMS coefficients.
  // https://bottosson.github.io/posts/oklab/#converting-from-xyz-to-oklab
  // XYZ->linear RGB: CSS Color 4 §19's rational D65 matrix.
  const fromXyz = ([x, y, z]) => [
    12831 / 3959 * x - 329 / 214 * y - 1974 / 3959 * z,
    -851781 / 878810 * x + 1648619 / 878810 * y + 36519 / 878810 * z,
    705 / 12673 * x - 2585 / 12673 * y + 705 / 667 * z,
  ];
  for (const [xyz, lab] of [
    [[.950, 1, 1.089], [1, 0, 0]],
    [[1, 0, 0], [.450, 1.236, -.019]],
    [[0, 1, 0], [.922, -.671, .263]],
    [[0, 0, 1], [.153, -1.415, -.449]],
  ]) closeVector(linearToOklab(fromXyz(xyz)), lab, 1e-3);

  closeVector(linearToOklab([1, 1, 1]), [1, 0, 0], 1e-14);
  for (const rgb of [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [-.25, .5, 1.25], [-1, -2, -3], [3, 2, 4],
    [1e-20, 2e-20, 3e-20], [1e20, -2e19, 3e19],
  ]) closeVector(oklabToLinear(linearToOklab(rgb)), rgb,
    Math.max(...rgb.map(Math.abs), 1e-30) * 3e-14);
});

test('Oklab mixing has perceptual progression while preserving out-of-gamut intermediates', () => {
  const black = sample([0, 0, 0]), white = sample([1, 1, 1]);
  closeVector(mixColorSamples(black, white, mask(.5), 'oklab').value, [.125, .125, .125]);
  assert.deepEqual(mixColorSamples(black, white, mask(.5), 'linear-rgb').value, [.5, .5, .5]);
  const greenBlue = mixColorSamples(sample([0, 1, 0]), sample([0, 0, 1]), mask(.5), 'oklab');
  assert.ok(greenBlue.value[0] < -.08, 'A perceptual mix must not clip its intermediate color to reflectance.');
  assert.ok(greenBlue.value[1] > .4 && greenBlue.value[2] > .51);
  assert.deepEqual(greenBlue.dx, zero);
  assert.deepEqual(greenBlue.dy, zero);
});

test('Oklab color differential applies both coordinate Jacobians and the mask product rule', () => {
  for (const [a, b] of [
    [sample([.15, .7, .35], [.1, -.3, .2], [-.07, .13, .21]),
      sample([.6, .05, 1.3], [-.2, .04, .3], [.11, -.08, .09])],
    [sample([-.5, -.3, -.2], [.04, -.1, .02], [-.1, .03, .07]),
      sample([-.2, -.6, -.9], [-.12, .08, .14], [.05, -.09, .03])],
  ]) {
    const factor = mask(.37, .21, -.13);
    const result = mixColorSamples(a, b, factor, 'oklab'), step = 1e-5;
    for (const direction of ['dx', 'dy']) {
      const at = amount => {
        const first = linearToOklab(a.value.map((value, i) => value + amount * a[direction][i]));
        const second = linearToOklab(b.value.map((value, i) => value + amount * b[direction][i]));
        const weight = factor.value + amount * factor[direction];
        return oklabToLinear(first.map((value, i) => value + (second[i] - value) * weight));
      };
      const high = at(step), low = at(-step);
      closeVector(result[direction], high.map((value, i) => (value - low[i]) / (2 * step)), 3e-10);
    }
  }
});

test('color interpolation preserves exact endpoint samples and reports singular Oklab tangents', () => {
  const first = sample([1e-20, 1e-25, 1e-30], [.1, .2, .3]);
  const singular = sample([0, 0, 0], [1, 0, 0]);
  for (const space of ['linear-rgb', 'oklab']) {
    for (const weight of [-2, 0]) assert.equal(mixColorSamples(first, singular, mask(weight, 3), space), first);
    for (const weight of [1, 4]) assert.equal(mixColorSamples(first, singular, mask(weight, 3), space), singular);
    assert.equal(mixColorSamples(singular, singular, mask(.5, 7), space), singular);
  }
  assert.throws(() => mixColorSamples(singular, sample([1, 1, 1]), mask(.5), 'oklab'),
    /derivative is undefined.*zero LMS component.*nonzero tangent/);
  const blackWhite = mixColorSamples(sample([0, 0, 0]), sample([1, 1, 1]), mask(.5, 2, 1), 'oklab');
  closeVector(blackWhite.dx, [1.5, 1.5, 1.5]);
  closeVector(blackWhite.dy, [.75, .75, .75]);
});

test('color ramp selects exact knots and clamped ends without interpolating them', () => {
  const positions = [-3, -.5, .25, 8];
  for (const interpolation of ['linear', 'smoothstep', 'constant']) {
    for (const [value, index] of [[-4, 0], ...positions.map((value, i) => [value, i]), [9, 3]]) {
      assert.deepEqual(rampInterval(value, positions, interpolation), {a: index, b: index, weight: 0, derivative: 0});
    }
  }
  assert.deepEqual(rampInterval(0, positions, 'constant'), {a: 1, b: 1, weight: 0, derivative: 0});
  assert.deepEqual(rampInterval(.251, positions, 'constant'), {a: 2, b: 2, weight: 0, derivative: 0});
});

test('color ramp weights and tangents use the selected interval width', () => {
  const positions = [-1, 1, 3];
  assert.deepEqual(rampInterval(0, positions, 'linear'), {a: 0, b: 1, weight: .5, derivative: .5});
  assert.deepEqual(rampInterval(0, positions, 'smoothstep'), {a: 0, b: 1, weight: .5, derivative: .75});
  const point = 1.5, step = 1e-5;
  for (const interpolation of ['linear', 'smoothstep']) {
    const interval = rampInterval(point, positions, interpolation);
    const high = rampInterval(point + step, positions, interpolation);
    const low = rampInterval(point - step, positions, interpolation);
    close(interval.derivative, (high.weight - low.weight) / (2 * step), 3e-11);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {toWorkingColor, convertColor, displayColor, decodeColorImage, encodeColorImage} from '../src/color/management.mts';
import {srgbToLinear, linearToOklab} from '../src/core/color.mts';

function close(actual, expected, tolerance = 2e-12) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance,
    `component ${i}: ${value} ≠ ${expected[i]}`));
}

test('tagged primaries use one extended linear Rec709 representation', () => {
  const red = toWorkingColor({space: 'display-p3', coords: [1, 0, 0]});
  // Independent D65 primary conversion values from CSS Color 4 §19 matrices.
  close(red, [1.2249401762805596, -.04205695470968818, -.019637554590334436]);
  close(convertColor({space: 'linear-rec709', coords: red}, 'display-p3').coords, [1, 0, 0]);
  close(toWorkingColor({space: 'srgb', coords: [128 / 255, 64 / 255, 1]}), srgbToLinear('#8040ff'), 0);
  close(convertColor({space: 'linear-display-p3', coords: [1, 1, 1]}, 'linear-rec709').coords, [1, 1, 1]);
  assert.ok(Object.isFrozen(red));
});

test('ordinary conversions preserve extended values and both halves of the transfer curve', () => {
  for (const coords of [[-.5, .02, 1.4], [-.0031308, .0031308, 0], [0, 0, 0], [.2, .4, .8]]) {
    const original = {space: 'linear-rec709', coords};
    for (const space of ['srgb', 'display-p3', 'linear-display-p3', 'oklab', 'oklch']) {
      close(toWorkingColor(convertColor(original, space)), coords, 3e-10);
    }
  }
  const authored = {space: 'oklch', coords: [.7, .42, 180]};
  const working = toWorkingColor(authored);
  assert.ok(working.some(v => v < 0 || v > 1));
  assert.deepEqual(authored, {space: 'oklch', coords: [.7, .42, 180]});
});

test('the explicit display boundary uses local MINDE and preserves in-gamut coordinates', () => {
  const p3red = {space: 'display-p3', coords: [1, 0, 0]};
  // CSS Color 4 local-MINDE reference result: chroma reduction, not hard clipping.
  close(displayColor(p3red, 'srgb').coords, [1, .04456951620418633, .04593161114017268], 1e-10);
  close(displayColor(p3red, 'display-p3').coords, [1, 0, 0], 2e-7);
  for (const coords of [[.2, .4, .6], [0, 0, 0], [1, 1, 1]]) {
    close(displayColor({space: 'srgb', coords}, 'srgb').coords, coords);
  }
  close(displayColor({space: 'oklab', coords: [1.1, .3, .4]}, 'srgb').coords, [1, 1, 1]);
  close(displayColor({space: 'oklab', coords: [-.1, .3, .4]}, 'display-p3').coords, [0, 0, 0]);
  const candidate = displayColor({space: 'oklch', coords: [.65, .5, 305]}, 'srgb');
  assert.ok(candidate.coords.every(v => v >= 0 && v <= 1));
  const lab = linearToOklab(toWorkingColor(candidate));
  assert.ok(Math.abs(lab[0] - .65) < .02);
  assert.ok(Object.isFrozen(candidate) && Object.isFrozen(candidate.coords));
});

test('RGB images decode before filtering and encode only at export', () => {
  const source = {width: 2, height: 1, channels: 3, data: [0, .5, 1, 1, 0, .5]};
  const linear = decodeColorImage(source, 'srgb');
  close(linear.data, [0, .21404114, 1, 1, 0, .21404114], 1e-8);
  const encoded = encodeColorImage(linear, 'srgb');
  close(encoded.data, source.data, 4e-8);
  assert.deepEqual(source.data, [0, .5, 1, 1, 0, .5]);
  assert.ok(Object.isFrozen(linear.data));
  assert.throws(() => decodeColorImage({width: 1, height: 1, channels: 1, data: [.5]}, 'srgb'), /scalar images/);
});

test('color management rejects ambiguous or nonfinite authored coordinates', () => {
  assert.throws(() => toWorkingColor({space: 'rgb', coords: [1, 0, 0]}), /Unknown color space/);
  assert.throws(() => toWorkingColor({space: 'srgb', coords: [1, NaN, 0]}), /finite/);
  assert.throws(() => toWorkingColor({space: 'oklch', coords: [.5, -.2, 30]}), /nonnegative/);
  assert.throws(() => displayColor({space: 'srgb', coords: [1, 0, 0]}, 'oklab'), /Display output/);
  assert.throws(() => toWorkingColor({space: 'srgb', coords: [1, 0, 0], alpha: .5}), /Unknown/);
});

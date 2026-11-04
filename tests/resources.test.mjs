import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeImage, isNormalizedImage, generateImage, sampleImage, IMAGE_LIMITS} from '../src/core/resources.mts';

const close = (actual, expected, tolerance = 1e-8) =>
  assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const gray = data => normalizeImage({width: 2, height: 2, channels: 1, data});

test('numeric images own float32 snapshots without freezing caller data', () => {
  const data = [.1, .2, .3, -0], input = {width: 2, height: 2, channels: 1, data};
  const image = normalizeImage(input);
  assert(isNormalizedImage(image));
  assert(!isNormalizedImage(input));
  assert(Object.isFrozen(image));
  assert(Object.isFrozen(image.data));
  assert(!Object.isFrozen(input));
  assert(!Object.isFrozen(data));
  assert.equal(normalizeImage(image), image);
  data[0] = 9;
  assert.equal(image.data[0], Math.fround(.1));
  assert(!Object.is(image.data[3], -0));
  assert.deepEqual(normalizeImage(JSON.parse(JSON.stringify(image))), image);
  const buffer = new Float32Array([1, 2, 3]);
  const color = normalizeImage({width: 1, height: 1, channels: 3, data: buffer});
  buffer[0] = 10;
  assert.deepEqual(color.data, [1, 2, 3]);
});

test('procedural generation evaluates texel centers once in lower-left row order', () => {
  const calls = [];
  const image = generateImage({width: 2, height: 2, channels: 1}, (u, v, x, y) => {
    calls.push([u, v, x, y]);
    return 2 * u + 3 * v;
  });
  assert.deepEqual(calls, [[.25, .25, 0, 0], [.75, .25, 1, 0], [.25, .75, 0, 1], [.75, .75, 1, 1]]);
  assert.deepEqual(image.data, [1.25, 2.25, 2.75, 3.75]);
  assert(isNormalizedImage(image));
  assert(!JSON.stringify(image).includes('function'));
  const reused = [0, 0, 0];
  const color = generateImage({width: 2, height: 1, channels: 3}, (u, v, x) => {
    reused[0] = x; reused[1] = u; reused[2] = v;
    return reused;
  });
  reused.fill(9);
  assert.deepEqual(color.data, [0, .25, .5, 1, .75, .5]);
});

test('bilinear reconstruction is exact for affine data and returns UV partials', () => {
  const image = generateImage({width: 4, height: 3, channels: 3}, (u, v) => [u, 3 * v, 2 * u - v]);
  for (const uv of [[.3, .35], [.52, .47], [.73, .8]]) {
    const sample = sampleImage(image, uv);
    sample.value.forEach((value, i) => close(value, [uv[0], 3 * uv[1], 2 * uv[0] - uv[1]][i], 5e-8));
    sample.du.forEach((value, i) => close(value, [1, 0, 2][i], 2e-7));
    sample.dv.forEach((value, i) => close(value, [0, 3, -1][i], 2e-7));
  }
});

test('bilinear partials agree with independent centered differences within cells', () => {
  const image = normalizeImage({width: 2, height: 2, channels: 3,
    data: [.1, .7, -.2, .8, .2, 1.5, .4, .6, .9, -.3, .4, .3]});
  const uv = [.43, .61], sample = sampleImage(image, uv), step = 1e-5;
  for (const [axis, derivative] of [[0, 'du'], [1, 'dv']]) {
    const at = sign => sampleImage(image, uv.map((value, i) => value + (i === axis ? sign * step : 0))).value;
    const low = at(-1), high = at(1);
    sample[derivative].forEach((value, i) => close(value, (high[i] - low[i]) / (2 * step), 1e-10));
  }
});

test('clamp addressing extends edge texels with zero derivatives in the clamped direction', () => {
  const image = gray([0, 2, 4, 6]);
  assert.deepEqual(sampleImage(image, [.5, .5]), {value: [3, 3, 3], du: [4, 4, 4], dv: [8, 8, 8]});
  for (const uv of [[-1, -1], [0, 0], [.1, .1]]) {
    assert.deepEqual(sampleImage(image, uv), {value: [0, 0, 0], du: [0, 0, 0], dv: [0, 0, 0]});
  }
  assert.deepEqual(sampleImage(image, [-1e20, .5]), {value: [2, 2, 2], du: [0, 0, 0], dv: [8, 8, 8]});
  assert.deepEqual(sampleImage(image, [.5, 1e20]), {value: [5, 5, 5], du: [4, 4, 4], dv: [0, 0, 0]});
  assert.deepEqual(sampleImage(image, [1e20, 1e20]), {value: [6, 6, 6], du: [0, 0, 0], dv: [0, 0, 0]});
});

test('repeat addressing interpolates across seams and is periodic in value and derivatives', () => {
  const image = gray([0, 2, 4, 6]);
  const center = sampleImage(image, [0, 0], 'repeat');
  assert.deepEqual(center, {value: [3, 3, 3], du: [-4, -4, -4], dv: [-8, -8, -8]});
  for (const uv of [[1, 1], [-1, 2], [100, -40]]) assert.deepEqual(sampleImage(image, uv, 'repeat'), center);
  const sample = sampleImage(image, [.125, .875], 'repeat');
  assert.deepEqual(sampleImage(image, [-.875, 2.875], 'repeat'), sample);
  const step = 1e-7;
  const before = sampleImage(image, [-step, .4], 'repeat'), after = sampleImage(image, [step, .4], 'repeat');
  before.value.forEach((value, i) => close(value, after.value[i], 1e-6));
  assert.deepEqual(before.du, after.du);
});

test('texel-center knots choose the right/upper derivative, including clamp endpoints', () => {
  const image = gray([0, 2, 4, 6]);
  assert.deepEqual(sampleImage(image, [.25, .25]), {value: [0, 0, 0], du: [4, 4, 4], dv: [8, 8, 8]});
  assert.deepEqual(sampleImage(image, [.75, .75]), {value: [6, 6, 6], du: [0, 0, 0], dv: [0, 0, 0]});
  assert.deepEqual(sampleImage(image, [.75, .75], 'repeat'), {value: [6, 6, 6], du: [-4, -4, -4], dv: [-8, -8, -8]});
});

test('one-texel axes stay constant under either address mode', () => {
  const image = normalizeImage({width: 1, height: 1, channels: 3, data: [.2, -.3, 4]});
  for (const address of ['clamp', 'repeat']) for (const uv of [[0, 0], [.5, .5], [9.5, -4.25]]) {
    assert.deepEqual(sampleImage(image, uv, address), {value: image.data, du: [0, 0, 0], dv: [0, 0, 0]});
  }
});

test('the resource boundary rejects invalid shape, components and procedural outputs', () => {
  const valid = {width: 1, height: 1, channels: 1, data: [0]};
  for (const width of [0, -1, 1.5, NaN, Infinity, IMAGE_LIMITS.dimension + 1]) {
    assert.throws(() => normalizeImage({...valid, width}), /Image width/);
  }
  for (const channels of [0, 2, 4, '1', null]) assert.throws(() => normalizeImage({...valid, channels}), /channels/);
  for (const data of [[], [1, 2], [undefined], [NaN], [Infinity], [3.5e38], ['1']]) {
    assert.throws(() => normalizeImage({...valid, data}), /Image data/);
  }
  assert.throws(() => normalizeImage({...valid, width: 4096, height: 4096}), /at most/);
  assert.throws(() => normalizeImage({...valid, encoding: 'srgb'}), /Unknown/);
  assert.throws(() => normalizeImage(Object.assign(new Date(), valid)), /plain object/);
  assert.throws(() => generateImage({width: 1, height: 1, channels: 1}, null), /sample function/);
  assert.throws(() => generateImage({width: 1, height: 1, channels: 1}, () => [1]), /finite float32/);
  assert.throws(() => generateImage({width: 1, height: 1, channels: 3}, () => [1, 2]), /three linear RGB/);
  assert.throws(() => generateImage({width: 1, height: 1, channels: 3}, () => [1, , 3]), /finite float32/);
});

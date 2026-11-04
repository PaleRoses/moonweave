import test from 'node:test';
import assert from 'node:assert/strict';
import {
  color, scalar, image, domain, named, createFieldSampler, inDomain,
} from '../src/core.mjs';
import {generateImage, normalizeImage, sampleImage, isNormalizedImage} from '../src/core/resources.mts';
import {
  imagePyramid, imageFilterPlan, sampleFilteredImage, MAX_IMAGE_ANISOTROPY, IMAGE_TAP_EPSILON,
} from '../src/core/image-filter.mts';

const close = (a, b, tolerance = 1e-10) => assert(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const closeVector = (a, b, tolerance) => a.forEach((value, i) => close(value, b[i], tolerance));
const closeSample = (a, b, tolerance = 1e-10) => {
  for (const key of ['value', 'du', 'dv']) closeVector(a[key], b[key], tolerance);
};
const rotation = (f, angle) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return {dx: f.dx.map((x, i) => x * c + f.dy[i] * s),
    dy: f.dy.map((y, i) => y * c - f.dx[i] * s)};
};
const checker = () => generateImage({width: 64, height: 64, channels: 1}, (_u, _v, x, y) => (x + y) % 2);

test('mip pyramids own and share derived levels while retaining odd edge texels', () => {
  const source = generateImage({width: 5, height: 3, channels: 1}, (_u, _v, x, y) => y * 5 + x);
  const levels = imagePyramid(source);
  assert.equal(imagePyramid(source), levels);
  assert.equal(levels[0], source);
  assert(Object.isFrozen(levels));
  assert.deepEqual(levels.map(level => [level.width, level.height]), [[5, 3], [2, 1], [1, 1]]);
  assert.deepEqual(levels[1].data, [Math.fround(5.8), Math.fround(8.2)]);
  assert.deepEqual(levels[2].data, [7]);
  for (const level of levels) {
    assert(isNormalizedImage(level));
    assert(Object.isFrozen(level));
    assert(Object.isFrozen(level.data));
  }
  const corner = generateImage({width: 3, height: 3, channels: 1}, (_u, _v, x, y) => x === 2 && y === 2 ? 1 : 0);
  assert.equal(imagePyramid(corner)[1].data[0], Math.fround(1 / 9));
});

test('area reduction preserves bounded masks, means and constant extended colors', () => {
  const source = generateImage({width: 13, height: 7, channels: 1}, (_u, _v, x, y) => ((x * 3 + y * 5) % 17) / 16);
  const mean = source.data.reduce((sum, value) => sum + value, 0) / source.data.length;
  for (const level of imagePyramid(source)) {
    assert(level.data.every(value => value >= 0 && value <= 1));
    close(level.data.reduce((sum, value) => sum + value, 0) / level.data.length, mean, 4e-8);
  }
  const rgb = [.25, -.5, 2];
  const constant = generateImage({width: 7, height: 5, channels: 3}, () => rgb);
  for (const level of imagePyramid(constant)) for (let i = 0; i < level.data.length; i += 3) {
    assert.deepEqual(level.data.slice(i, i + 3), rgb);
  }
  const extreme = normalizeImage({width: 3, height: 3, channels: 1, data: Array(9).fill(3.4028234663852886e38)});
  assert.equal(imagePyramid(extreme)[1].data[0], extreme.data[0]);
});

test('zero addressing has finite tent support and the defined one-sided boundary derivatives', () => {
  const source = normalizeImage({width: 1, height: 1, channels: 1, data: [1]});
  assert.deepEqual(sampleImage(source, [0, .25], 'zero'), {
    value: [.375, .375, .375], du: [.75, .75, .75], dv: [.5, .5, .5],
  });
  assert.deepEqual(sampleImage(source, [-.5, .25], 'zero'), {
    value: [0, 0, 0], du: [.75, .75, .75], dv: [0, 0, 0],
  });
  for (const uv of [[-1, .25], [1.5, .25], [.5, 1e38], [-1e38, 0]]) {
    assert.deepEqual(sampleImage(source, uv, 'zero'), {value: [0, 0, 0], du: [0, 0, 0], dv: [0, 0, 0]});
  }
});

test('zero and omitted footprints preserve the original point reconstruction exactly', () => {
  const source = generateImage({width: 5, height: 3, channels: 3}, (u, v) => [u, v, u * v]);
  for (const address of ['clamp', 'repeat', 'zero']) for (const filter of ['linear', 'trilinear', 'anisotropic']) {
    for (const uv of [[.37, .42], [0, .3], [.5, .5], [-.05, .2], [2, -.4]]) {
      const base = sampleImage(source, uv, address);
      assert.deepEqual(sampleFilteredImage(source, uv, address, filter), base);
      assert.deepEqual(sampleFilteredImage(source, uv, address, filter, {dx: [0, 0], dy: [0, 0]}), base);
    }
  }
  const context = {position: [.37, .42, 0], dx: [1, 0, 0], dy: [0, 1, 0]};
  const pixels = image.data(source);
  const point = createFieldSampler(color.image(pixels))(context);
  assert.deepEqual(createFieldSampler(color.image(pixels, {filter: 'anisotropic'}))(context), point);
});

test('trilinear filtering removes a subpixel checker and blends values with their partials', () => {
  const source = checker(), uv = [.5 / 64, .5 / 64];
  assert.equal(sampleImage(source, uv, 'repeat').value[0], 0);
  const minified = sampleFilteredImage(source, uv, 'repeat', 'trilinear', {dx: [4 / 64, 0], dy: [0, 4 / 64]});
  assert.deepEqual(minified, {value: [.5, .5, .5], du: [0, 0, 0], dv: [0, 0, 0]});
  const fraction = .75, size = 2 ** fraction / 64;
  const mixed = sampleFilteredImage(source, uv, 'repeat', 'trilinear', {dx: [size, 0], dy: [0, size]});
  const base = sampleImage(source, uv, 'repeat');
  close(mixed.value[0], .5 * fraction);
  close(mixed.du[0], base.du[0] * (1 - fraction));
  close(mixed.dv[0], base.dv[0] * (1 - fraction));
});

test('anisotropic filtering retains detail along the minor axis at a bounded tap count', () => {
  const source = generateImage({width: 64, height: 64, channels: 1}, (_u, _v, _x, y) => y % 2);
  const uv = [.37, .5 / 64], footprint = {dx: [8 / 64, 0], dy: [0, 1 / 64]};
  assert.equal(imageFilterPlan(source, footprint, 'anisotropic').taps, MAX_IMAGE_ANISOTROPY);
  assert.equal(sampleFilteredImage(source, uv, 'repeat', 'trilinear', footprint).value[0], .5);
  assert.equal(sampleFilteredImage(source, uv, 'repeat', 'anisotropic', footprint).value[0], 0);
});

test('footprint covariance is invariant to rotating the screen basis, including numerical isotropy', () => {
  const source = generateImage({width: 64, height: 32, channels: 1}, (u, v) => .5 + .25 * Math.sin(19 * u) * Math.cos(27 * v));
  const footprint = {dx: [3 / 64, 1 / 32], dy: [.2 / 64, 1 / 32]};
  const before = imageFilterPlan(source, footprint, 'anisotropic');
  const sample = sampleFilteredImage(source, [.39, .43], 'repeat', 'anisotropic', footprint);
  for (const angle of [.1, .5, .77, 1.2, 2.3]) {
    const rotated = rotation(footprint, angle), after = imageFilterPlan(source, rotated, 'anisotropic');
    assert.equal(after.taps, before.taps);
    close(after.lod, before.lod, 1e-12);
    closeSample(sampleFilteredImage(source, [.39, .43], 'repeat', 'anisotropic', rotated), sample, 2e-12);
  }
  for (const angle of [0, Math.PI / 6, Math.PI / 4, Math.PI / 3, Math.PI / 2]) {
    const isotropic = rotation({dx: [2 / 64, 0], dy: [0, 2 / 64]}, angle);
    const plan = imageFilterPlan({width: 64, height: 64}, isotropic, 'anisotropic');
    assert.equal(plan.taps, 1);
    close(plan.lod, 1, 1e-12);
  }
});

test('tap quantization has an explicit narrow convention around integer ratios', () => {
  const source = {width: 64, height: 64};
  const count = ratio => imageFilterPlan(source, {dx: [ratio / 64, 0], dy: [0, 1 / 64]}, 'anisotropic').taps;
  assert.equal(count(2 - IMAGE_TAP_EPSILON), 2);
  assert.equal(count(2), 2);
  assert.equal(count(2 + IMAGE_TAP_EPSILON / 2), 2);
  assert.equal(count(2 + 2 * IMAGE_TAP_EPSILON), 3);
  assert.equal(count(128), 8);
});

test('periodic filtered samples use a local representative before anisotropic tap offsets', () => {
  const source = generateImage({width: 17, height: 13, channels: 3}, (u, v) => [Math.sin(17 * u), u * v, Math.cos(13 * v)]);
  const footprint = {dx: [.23, .012], dy: [.027, .09]}, uv = [.203125, .9375];
  const expected = sampleFilteredImage(source, uv, 'repeat', 'anisotropic', footprint);
  for (const offset of [[17, -16], [4096, -8192], [2 ** 40, -(2 ** 40)]]) {
    assert.deepEqual(sampleFilteredImage(source, uv.map((v, i) => v + offset[i]), 'repeat', 'anisotropic', footprint), expected);
  }
});

test('filtered UV partials match finite differences with the footprint held fixed', () => {
  const source = generateImage({width: 17, height: 13, channels: 3}, (u, v) => [Math.sin(17 * u), u * v, Math.cos(13 * v)]);
  const footprint = {dx: [.23, .012], dy: [.027, .09]}, uv = [.413, .573], delta = 1e-6;
  for (const address of ['clamp', 'repeat', 'zero']) for (const filter of ['trilinear', 'anisotropic']) {
    const sample = sampleFilteredImage(source, uv, address, filter, footprint);
    for (const [axis, key] of [[0, 'du'], [1, 'dv']]) {
      const at = sign => sampleFilteredImage(source, uv.map((v, i) => v + (i === axis ? sign * delta : 0)), address, filter, footprint);
      const before = at(-1), after = at(1);
      sample[key].forEach((value, i) => close(value, (after.value[i] - before.value[i]) / (2 * delta), 3e-9));
    }
  }
});

test('fractional LOD values and partials are continuous across stored and virtual level boundaries', () => {
  const source = generateImage({width: 5, height: 3, channels: 1}, (u, v) => u * v + .2);
  const uv = [.23, .63];
  for (const address of ['clamp', 'repeat', 'zero']) for (const level of [1, 2, 3, 4]) {
    const sample = shift => {
      const size = 2 ** (level + shift);
      return sampleFilteredImage(source, uv, address, 'trilinear', {dx: [size / 5, 0], dy: [0, size / 3]});
    };
    closeSample(sample(-1e-8), sample(1e-8), 2e-8);
  }
});

test('singleton palette axes do not blur color, while zero-extended axes keep their finite bounds', () => {
  const palette = generateImage({width: 8, height: 1, channels: 3}, (u) => [u, u * u, 1 - u]);
  const footprint = {dx: [0, 1e20], dy: [0, -1e20]};
  for (const filter of ['trilinear', 'anisotropic']) for (const address of ['clamp', 'repeat']) {
    assert.deepEqual(sampleFilteredImage(palette, [.37, .41], address, filter, footprint), sampleImage(palette, [.37, .41], address));
  }
  const stamp = normalizeImage({width: 1, height: 8, channels: 1, data: Array(8).fill(1)});
  const sample = sampleFilteredImage(stamp, [.5, .5], 'zero', 'trilinear', {dx: [8, 0], dy: [0, 1]});
  close(sample.value[0], 1 / 8);
});

test('virtual zero levels keep shrinking a subpixel stamp and preserve its integrated mass', () => {
  const source = normalizeImage({width: 1, height: 1, channels: 1, data: [1]});
  for (const level of [0, 1, 2, 5]) {
    const size = 2 ** level, footprint = {dx: [size, 0], dy: [0, size]};
    close(sampleFilteredImage(source, [.5, .5], 'zero', 'trilinear', footprint).value[0], 1 / size ** 2);
  }
  const level = 2.5, size = 2 ** level, extent = 2 ** Math.ceil(level);
  const footprint = {dx: [size, 0], dy: [0, size]}, cells = 64, spacing = 2 * extent / cells;
  let integral = 0;
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const uv = [.5 - extent + (x + .5) * spacing, .5 - extent + (y + .5) * spacing];
    integral += sampleFilteredImage(source, uv, 'zero', 'trilinear', footprint).value[0] * spacing ** 2;
  }
  close(integral, 1, 2e-12);
});

test('huge finite footprints and far zero-address coordinates remain finite', () => {
  const source = generateImage({width: 4096, height: 1, channels: 1}, (u) => u);
  const footprint = {dx: [3e38, 2e38], dy: [1e38, -2e38]};
  for (const address of ['clamp', 'repeat', 'zero']) for (const filter of ['trilinear', 'anisotropic']) {
    const plan = imageFilterPlan(source, footprint, filter, address);
    assert(Number.isFinite(plan.lod));
    assert(plan.step.every(Number.isFinite));
    assert(plan.taps >= 1 && plan.taps <= MAX_IMAGE_ANISOTROPY);
    const sample = sampleFilteredImage(source, [3e38, -2e38], address, filter, footprint);
    assert(Object.values(sample).flat().every(Number.isFinite));
  }
});

test('CPU footprints are owned and transported independently of derivative directions', () => {
  const pixels = image.data(generateImage({width: 16, height: 16, channels: 1}, (u, v) => u * v + .1 * Math.sin(18 * u)));
  const frame = domain.transform([2, .1, 0, 0, .2, 1.5, 0, 0, 0, 0, 1, 0, .1, -.05, 0, 1]);
  const context = {position: [.13, .25, 0], dx: [1, 0, 0], dy: [0, 1, 0], footprint: {dx: [.17, .01, 0], dy: [.02, .06, 0]}};
  const original = structuredClone(context);
  const transported = createFieldSampler(frame)(context);
  closeVector(transported.footprint.dx, [.342, .032, 0]);
  closeVector(transported.footprint.dy, [.052, .092, 0]);
  assert(Object.isFrozen(transported.footprint));
  assert(Object.isFrozen(transported.footprint.dx));
  assert.deepEqual(context, original);
  assert(!Object.isFrozen(context.footprint.dx));
  assert.equal('footprint' in createFieldSampler(frame)({}), false);
  const field = createFieldSampler(inDomain(scalar.image(pixels, {filter: 'anisotropic'}), frame));
  const sample = field(context), scaled = field({...context, dx: [3, 0, 0], dy: [0, -2, 0]});
  assert.equal(sample.value, scaled.value);
  close(scaled.dx, 3 * sample.dx);
  close(scaled.dy, -2 * sample.dy);
  const delta = 1e-6;
  for (const [axis, key] of [[0, 'dx'], [1, 'dy']]) {
    const at = sign => field({...context, position: context.position.map((v, i) => v + (i === axis ? sign * delta : 0))}).value;
    close(sample[key], (at(1) - at(-1)) / (2 * delta), 2e-9);
  }
});

test('filtered coverage retains the complete masked-height product rule', () => {
  const pixels = image.data(generateImage({width: 16, height: 16, channels: 1}, (u, v) => u * v));
  const mask = scalar.image(pixels, {address: 'zero', filter: 'anisotropic'});
  const height = scalar.add(.02, scalar.multiply(.005, scalar.axis('x')));
  const product = createFieldSampler(scalar.multiply(mask, height));
  const context = {position: [.37, .41, 0], dx: [1, 0, 0], dy: [0, 1, 0], footprint: {dx: [.21, .01, 0], dy: [0, .08, 0]}};
  const sample = product(context), delta = 1e-6;
  assert(sample.dx !== 0 && sample.dy !== 0);
  for (const [axis, key] of [[0, 'dx'], [1, 'dy']]) {
    const at = sign => product({...context, position: context.position.map((v, i) => v + (i === axis ? sign * delta : 0))}).value;
    close(sample[key], (at(1) - at(-1)) / (2 * delta), 1e-10);
  }
});

test('sample boundaries reject incoherent footprints without retaining caller data', () => {
  const sample = createFieldSampler(named('frame', domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])));
  for (const footprint of [null, [], {}, {dx: [0, 0, 0]}, {dx: [0, 0], dy: [0, 0, 0]},
    {dx: [Infinity, 0, 0], dy: [0, 0, 0]}, {dx: [0, 0, 0], dy: [0, 0, 0], width: 1}]) {
    assert.throws(() => sample({footprint}), /footprint/);
  }
});

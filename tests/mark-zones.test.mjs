import test from 'node:test';
import assert from 'node:assert/strict';
import {bakeMarks, compileMarkProgram} from '../src/paint/mark-raster.mts';
import {sampleFilteredImage} from '../src/core/image-filter.mts';

const solid = {width: 4, height: 4, channels: 1, data: Array(16).fill(1)};
// Every sample in the bake lies inside this brush's constant interior.
const globalTransform = [3, 0, 0, 3, -1, -1];
const fields = bake => [bake.pigment, bake.coverage, bake.finishValues, bake.finishCoverage, bake.opacityHeight];
const style = index => ({kind: 'dab', color: [.2 + (index % 3) * .2, .4, .7],
  opacity: .6, height: index % 2 ? -.02 : .03,
  channels: {roughness: .3, metalness: .2, clearcoat: .1, opacity: .8}});

test('finite zones clip global brush candidates while preserving every associated output', () => {
  const zones = {}, marks = [], local = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const i = y * 8 + x, name = `zone${i}`;
    const transform = [.07, 0, 0, .07, (x + .5) / 8 - .035, (y + .5) / 8 - .035];
    zones[name] = {mask: solid, filter: 'linear', transform};
    marks.push({...style(i), brush: 'tip', transform: globalTransform, zone: name});
    local.push({...style(i), brush: 'tip', transform});
  }
  const options = {width: 64, height: 64, samples: 2};
  const brushes = {tip: {mask: solid, filter: 'linear'}};
  const actual = bakeMarks({brushes, zones, marks}, options);
  const expected = bakeMarks({brushes, marks: local}, options);
  assert.deepEqual(fields(actual), fields(expected));
  assert.equal(actual.stats.tileReferences, expected.stats.tileReferences);
  assert.equal(actual.stats.dabTests, expected.stats.dabTests);
  assert.ok(actual.stats.dabTests < marks.length * actual.stats.samples / 8);
  assert.ok(actual.coverage.data.some(value => value > 0));
});

test('zone reuse is local to one quadrature sample and one bake', () => {
  const mask = {width: 3, height: 2, channels: 1, data: [.1, .7, .3, .8, .2, 1]};
  const zone = {mask, filter: 'linear', transform: [.8, .1, -.1, .9, .1, .05]};
  const brushes = {tip: {mask: solid, filter: 'linear'}};
  const marks = Array.from({length: 3}, (_, i) => ({...style(i), brush: 'tip',
    transform: globalTransform, zone: 'shared'}));
  const shared = compileMarkProgram({brushes, zones: {shared: zone}, marks});
  const separate = compileMarkProgram({brushes,
    zones: Object.fromEntries(marks.map((_, i) => [`zone${i}`, zone])),
    marks: marks.map((mark, i) => ({...mark, zone: `zone${i}`}))});
  for (const options of [{width: 16, height: 12, samples: 1}, {width: 32, height: 24, samples: 3}]) {
    const a = shared.bake(options), b = separate.bake(options);
    assert.deepEqual(fields(a), fields(b));
    assert.equal(a.stats.zoneSamples * marks.length, b.stats.zoneSamples);
    assert.ok(a.stats.zoneSamples > 0);
    assert.deepEqual(shared.bake(options), a);
  }
});

test('clipped zone bounds retain affine, anisotropic and subpixel filtering support', () => {
  const mask = {width: 7, height: 3, channels: 1, data: Array.from({length: 21}, (_, i) => (i % 5) / 4)};
  const transforms = [[.003, .001, -.23, .7, .48, .13], [.002, .001, -.001, .002, .49, .49]];
  const width = 48, height = 32, samples = 2, opacity = .6;
  for (const filter of ['linear', 'trilinear', 'anisotropic']) for (const transform of transforms) {
    const input = {brushes: {tip: {mask: solid, filter: 'linear'}},
      zones: {detail: {mask, filter, transform}},
      marks: [{...style(0), brush: 'tip', transform: globalTransform, zone: 'detail', opacity}]};
    const actual = bakeMarks(input, {width, height, samples});
    const [a, b, c, d, e, f] = transform, determinant = a * d - b * c;
    const inverse = [d / determinant, -b / determinant, -c / determinant, a / determinant,
      (c * f - d * e) / determinant, (b * e - a * f) / determinant];
    const footprint = {dx: [inverse[0] / width / samples, inverse[1] / width / samples],
      dy: [inverse[2] / height / samples, inverse[3] / height / samples]};
    const expected = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
        const px = (x + (sx + .5) / samples) / width, py = (y + (sy + .5) / samples) / height;
        const uv = [inverse[0] * px + inverse[2] * py + inverse[4],
          inverse[1] * px + inverse[3] * py + inverse[5]];
        sum += opacity * sampleFilteredImage(mask, uv, 'zero', filter, footprint).value[0];
      }
      expected.push(Math.fround(sum / (samples * samples)));
    }
    assert.deepEqual(actual.coverage.data, expected, `${filter}: ${transform}`);
  }
});

test('disjoint brush and zone supports produce no spatial candidates', () => {
  const bake = bakeMarks({brushes: {tip: {mask: solid, filter: 'linear'}},
    zones: {distant: {mask: solid, filter: 'linear', transform: [.05, 0, 0, .05, .8, .8]}},
    marks: [{...style(0), brush: 'tip', transform: [.05, 0, 0, .05, .1, .1], zone: 'distant'}]},
  {width: 32, height: 32});
  assert.equal(bake.stats.tileReferences, 0);
  assert.equal(bake.stats.dabTests, 0);
  assert.equal(bake.stats.zoneSamples, 0);
  assert.ok(fields(bake).every(image => image.data.every(value => value === 0)));
});

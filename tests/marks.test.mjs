import test from 'node:test';
import assert from 'node:assert/strict';
import {markProgram, parseMarkProgram, serializeMarkProgram, MARK_LIMITS} from '../src/paint/marks.mts';
import {bakeMarks, compileMarkProgram} from '../src/paint/mark-raster.mts';
import {applyMarkBake} from '../src/paint/mark-apply.mts';
import {sampleFilteredImage, prepareImageSampler} from '../src/core/image-filter.mts';
import {normalizeImage} from '../src/core/resources.mts';
import {color, surface, materialGraph, parseGraph, serializeGraph, evaluateColor, evaluateScalar} from '../src/core.mjs';

const solid = {width: 1, height: 1, channels: 1, data: [1]};
const identity = [1, 0, 0, 1, 0, 0];
const dab = (color, extra = {}) => ({kind: 'dab', brush: 'tip', transform: identity, color, ...extra});
const program = marks => ({brushes: {tip: {mask: solid, filter: 'linear'}}, marks});
function close(actual, expected, epsilon = 3e-7) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= epsilon, `${i}: ${value} ≠ ${expected[i]}`));
}

test('program ownership preserves shared raw masks, snapshots paths, and roundtrips JSON', () => {
  const mask = {width: 1, height: 1, channels: 1, data: [.5]};
  const input = {brushes: {tip: {mask}}, zones: {body: {mask}}, marks: [dab([.2, .4, .6], {zone: 'body'})]};
  const owned = markProgram(input);
  assert.equal(markProgram(owned), owned);
  assert.equal(compileMarkProgram(owned).program, owned);
  assert.equal(owned.brushes.tip.mask, owned.zones.body.mask);
  assert.notEqual(owned.brushes.tip.mask, mask);
  assert.ok(Object.isFrozen(owned.marks[0].color));
  assert.equal(Object.isFrozen(mask), false);
  mask.data[0] = 0;
  input.marks[0].color[0] = .9;
  assert.equal(owned.brushes.tip.mask.data[0], .5);
  assert.equal(owned.marks[0].color[0], .2);
  const serialized = serializeMarkProgram(owned);
  const parsed = parseMarkProgram(serialized), wire = JSON.parse(serialized);
  assert.equal(serializeMarkProgram(parsed), serialized);
  assert.equal(parsed.brushes.tip.mask, parsed.zones.body.mask);
  assert.equal(wire.images.length, 1);
  assert.equal(wire.brushes.tip.image, wire.zones.body.image);
  assert.equal(serialized.includes('dabCount'), false);
  wire.zones.body.image = 3;
  assert.throws(() => parseMarkProgram(JSON.stringify(wire)), /image reference/);
});

test('frozen caller programs still normalize once instead of borrowing an unproved shape', () => {
  const raw = Object.freeze(program([Object.freeze(dab([.2, .4, .6]))]));
  const owned = markProgram(raw);
  assert.notEqual(owned, raw);
  assert.equal(owned.version, 1);
  assert.equal(owned.marks[0].opacity, 1);
  assert.equal(owned.marks[0].height, 0);
  assert.equal(markProgram(owned), owned);
  assert.throws(() => markProgram(Object.freeze(program([dab([1.1, 0, 0])]))), /gamut-map/);
});

test('ordered deposition integrates associated pigment, independent finishes, and covered height', () => {
  const red = dab([1, 0, 0], {opacity: .5, height: .2, channels: {roughness: .2, opacity: .7}});
  const blue = dab([0, 0, 1], {opacity: .25, height: -.04, channels: {metalness: .9}});
  const baked = bakeMarks(program([red, blue]), {width: 1, height: 1, samples: 1});
  close(baked.pigment.data, [.375, 0, .25]);
  close(baked.coverage.data, [.625]);
  close(baked.finishValues.data, [.1, .225, 0]);
  close(baked.finishCoverage.data, [.5, .25, 0]);
  close(baked.opacityHeight.data, [.35, .5, .09]);
  assert.deepEqual(baked.channels, ['roughness', 'metalness', 'opacity']);
  assert.equal(baked.hasHeight, true);
  close(bakeMarks(program([blue, red]), {width: 1, height: 1, samples: 1}).pigment.data, [.5, 0, .125]);
});

test('zone coverage participates before ordered accumulation and height integration', () => {
  const input = program([dab([.2, .4, .8], {zone: 'belly', opacity: .8, height: .3})]);
  input.zones = {belly: {mask: {width: 1, height: 1, channels: 1, data: [.5]}, filter: 'linear'}};
  const bake = bakeMarks(input, {width: 1, height: 1, samples: 1});
  close(bake.coverage.data, [.4]);
  close(bake.pigment.data, [.08, .16, .32]);
  close(bake.opacityHeight.data, [0, 0, .12]);
  const distant = bakeMarks(input, {width: 4, height: 4, bounds: [10, 10, 11, 11]});
  assert.ok(distant.coverage.data.every(value => value === 0));
  assert.equal(distant.stats.dabTests, 0);
});

test('unemitted marks do not retain finish readers, height, or unused zone placements', () => {
  const visible = dab([.2, .4, .6]);
  const inactive = {color: [.8, .3, .1], height: .04, zone: 'unused',
    channels: {roughness: .4, metalness: .6, clearcoat: .2, opacity: .8}};
  const input = program([
    visible,
    dab(inactive.color, {...inactive, opacity: 0}),
    {kind: 'stroke', brush: 'tip', ...inactive, radius: .1,
      points: [{at: [0, .5], pressure: 0}, {at: [1, .5], pressure: 0}]},
  ]);
  input.zones = {unused: {mask: solid}};
  const shape = {width: 8, height: 8};
  const actual = bakeMarks(input, shape), expected = bakeMarks(program([visible]), shape);
  assert.deepEqual(actual, expected);
  const base = surface.paint('carapace');
  const graph = materialGraph(applyMarkBake(base, actual));
  assert.equal(serializeGraph(graph), serializeGraph(materialGraph(applyMarkBake(base, expected))));
  assert.equal(graph.nodes.filter(node => node.kind === 'image').length, 2);
  assert.equal(graph.nodes.some(node => node.kind === 'bump'), false);
});

test('active zone references preserve identity and order after pruning unused placements', () => {
  const marks = [dab([.8, .2, .1], {zone: 'second'}), dab([.1, .3, .8], {zone: 'first'})];
  const first = {mask: {width: 1, height: 1, channels: 1, data: [.3]}, filter: 'linear'};
  const second = {mask: {width: 1, height: 1, channels: 1, data: [.7]}, filter: 'linear'};
  const input = {...program(marks), zones: {first, unused: {mask: solid}, second}};
  const compiled = compileMarkProgram(input);
  assert.deepEqual(Object.keys(compiled.program.zones), ['first', 'unused', 'second']);
  const expected = bakeMarks({...input, zones: {first, second}}, {width: 4, height: 4});
  assert.deepEqual(compiled.bake({width: 4, height: 4}), expected);
});

test('all authored affine inverses are validated before unused placements are pruned', () => {
  const transform = [1e-20, 0, 0, 1, 1e20, 0];
  // Its linear inverse is in range, but the inverse translation is -1e40.
  assert.throws(() => markProgram({...program([]), zones: {unused: {mask: solid, transform}}}), /zone transform inverse/);
  assert.throws(() => markProgram(program([dab([.2, .4, .6], {transform, opacity: 0})])), /dab transform inverse/);
  assert.throws(() => markProgram(program([{kind: 'stroke', brush: 'tip', color: [.2, .4, .6],
    radius: .1, transform, points: [{at: [0, 0], pressure: 0}]}])), /stroke transform inverse/);
});

test('stroke spacing follows path distance and pressure; equivalent collinear paths agree', () => {
  const stroke = {kind: 'stroke', brush: 'tip', color: [.3, .5, .7], radius: .1, spacing: 1,
    points: [{at: [0, .5], pressure: 1}, {at: [1, .5], pressure: .5}]};
  const split = {...stroke, points: [stroke.points[0], {at: [.5, .5], pressure: .75}, stroke.points[1]]};
  const first = compileMarkProgram(program([stroke])), second = compileMarkProgram(program([split]));
  assert.equal(first.dabCount, 11);
  assert.equal(second.dabCount, 11);
  const options = {width: 64, height: 16, bounds: [-.1, .2, 1.1, .8], samples: 2};
  close(first.bake(options).coverage.data, second.bake(options).coverage.data, 1e-7);
  const zero = compileMarkProgram(program([{...stroke, points: [{at: [.5, .5], pressure: 0}]}]));
  assert.equal(zero.dabCount, 0);
  assert.ok(zero.bake(options).coverage.data.every(value => value === 0));
});

test('floating-point subdivision cannot add a nearly coincident endpoint dab', () => {
  const end = [3 / 17, 3 / 31], radius = Math.hypot(...end) / 5;
  const stroke = {kind: 'stroke', brush: 'tip', color: [.3, .5, .7], radius, spacing: 1,
    points: [{at: [0, 0]}, {at: end}]};
  const subdivided = {...stroke, points: [{at: [0, 0]}, {at: end.map(v => v * .37)}, {at: end}]};
  const first = compileMarkProgram(program([stroke])), second = compileMarkProgram(program([subdivided]));
  assert.equal(first.dabCount, 6);
  assert.equal(second.dabCount, 6);
  const options = {width: 32, height: 32, bounds: [-.1, -.1, .3, .2], samples: 2};
  close(first.bake(options).coverage.data, second.bake(options).coverage.data, 1e-7);
});

test('affine, subpixel and anisotropic brush bounds preserve the existing filtered sampling contract', () => {
  const mask = {width: 7, height: 3, channels: 1, data: Array.from({length: 21}, (_, i) => (i % 5) / 4)};
  const transform = [.003, .001, -.23, .7, .48, .13];
  const input = {brushes: {tip: {mask, filter: 'anisotropic'}}, marks: [dab([.8, .3, .1], {transform, opacity: .6, height: .02})]};
  const width = 48, height = 48, samples = 2;
  const actual = bakeMarks(input, {width, height, samples});
  const [a, b, c, d, e, f] = transform, determinant = a * d - b * c;
  const footprint = {dx: [d / determinant / width / samples, -b / determinant / width / samples],
    dy: [-c / determinant / height / samples, a / determinant / height / samples]};
  const expected = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = (x + (sx + .5) / samples) / width - e, py = (y + (sy + .5) / samples) / height - f;
      const uv = [(d * px - c * py) / determinant, (-b * px + a * py) / determinant];
      sum += sampleFilteredImage(mask, uv, 'zero', 'anisotropic', footprint).value[0] * .6;
    }
    expected.push(sum / (samples * samples));
  }
  close(actual.coverage.data, expected, 1e-8);
  assert.ok(actual.coverage.data.some(value => value > 0));
  actual.coverage.data.forEach((coverage, i) => close(actual.pigment.data.slice(i * 3, i * 3 + 3), [.8 * coverage, .3 * coverage, .1 * coverage], 1e-8));
});

test('fixed-footprint preparation preserves filtered values and partials exactly', () => {
  const mask = normalizeImage({width: 3, height: 2, channels: 1, data: [.2, .7, .1, .8, .3, 1]});
  for (const filter of ['linear', 'trilinear', 'anisotropic']) for (const address of ['zero', 'repeat', 'clamp']) {
    const footprint = {dx: [.5, .1], dy: [.02, .03]};
    const sample = prepareImageSampler(mask, address, filter, footprint);
    for (const uv of [[.3, .4], [-.2, 1.3], [.5, .5]]) {
      assert.deepEqual(sample(uv), sampleFilteredImage(mask, uv, address, filter, footprint));
    }
  }
});

test('tile bins reduce candidate work without changing deterministic authored order', () => {
  const marks = [];
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) marks.push(dab([.2, .4, .8], {
    transform: [.018, 0, 0, .018, (x + .5) / 24 - .009, (y + .5) / 24 - .009],
  }));
  const compiled = compileMarkProgram(program(marks));
  const options = {width: 128, height: 128, samples: 1};
  const first = compiled.bake(options), second = compiled.bake(options);
  assert.deepEqual(first, second);
  assert.ok(first.stats.dabTests < marks.length * 128 * 128 / 12, JSON.stringify(first.stats));
  assert.ok(first.stats.tileReferences < marks.length * 4);
});

test('a bake lowers to shared image nodes, associated deposition and the complete height field', () => {
  const bake = bakeMarks(program([dab([.2, .4, .6], {opacity: .5, height: .08,
    channels: {roughness: .3, metalness: .2, clearcoat: .1, opacity: .8}})]), {width: 4, height: 4});
  const graph = materialGraph(applyMarkBake(surface.material(color.linear([.1, .1, .1])), bake));
  assert.equal(graph.nodes.filter(node => node.kind === 'image').length, 5);
  const deposit = graph.nodes.find(node => node.kind === 'deposit');
  assert.ok(deposit);
  const bump = graph.nodes.find(node => node.kind === 'bump');
  const sample = {position: [.5, .5, 0], dx: [1, 0, 0], dy: [0, 1, 0]};
  const coverage = evaluateScalar(graph, deposit.mask, sample).value;
  close(evaluateColor(graph, deposit.color, sample).value, [.2 * coverage, .4 * coverage, .6 * coverage]);
  close([evaluateScalar(graph, bump.height, sample).value], [.08 * coverage]);
  assert.equal(serializeGraph(parseGraph(serializeGraph(graph))), serializeGraph(graph));
  const base = surface.material(color.linear([.2, .2, .2]));
  const empty = bakeMarks(program([]), {width: 1, height: 1});
  assert.equal(applyMarkBake(base, empty), base);
});

test('application owns raw base and placement as one graph and snapshots raw bake resources', () => {
  const bake = bakeMarks(program([dab([.2, .4, .6])]), {width: 4, height: 4});
  const raw = JSON.parse(JSON.stringify(bake));
  const frame = {kind: 'transform', id: 'sharedMarkFrame', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]};
  const base = {kind: 'material', color: {kind: 'colorMix', a: {kind: 'color', value: [.1, .2, .3]},
    b: {kind: 'color', value: [.2, .3, .4]}, mask: {kind: 'noise', seed: 1, domain: frame}}};
  const graph = materialGraph(applyMarkBake(base, raw, {domain: frame}));
  assert.equal(graph.nodes.filter(node => node.id === 'sharedMarkFrame').length, 1);
  const before = serializeGraph(graph);
  raw.pigment.data.fill(1); frame.matrix[12] = 7;
  assert.equal(serializeGraph(graph), before);
  assert.equal(Object.isFrozen(base), false);
  assert.equal(Object.isFrozen(frame), false);
  assert.equal(Object.isFrozen(raw.pigment.data), false);
  const alteredStats = {...bake, stats: {...bake.stats, dabs: 0}};
  const retained = materialGraph(applyMarkBake(surface.material(color.linear([.1, .1, .1])), alteredStats));
  assert.ok(retained.nodes.some(node => node.kind === 'deposit'));
  assert.throws(() => applyMarkBake(base, {...bake, bounds: [0, 0, 0, 1]}), /positive area/);
});

test('program and bake limits reject ambiguous inputs before expansion', () => {
  assert.throws(() => markProgram(program([dab([1.1, 0, 0])])), /gamut-map/);
  assert.throws(() => markProgram(program([dab([1, 0, 0], {transform: [1, 0, 0, 0, 0, 0]})])), /invertible/);
  assert.throws(() => markProgram(program([dab([1, 0, 0], {brush: 'missing'})])), /Unknown mark brush/);
  assert.throws(() => parseMarkProgram('{"version":2}'), /Unsupported/);
  assert.throws(() => parseMarkProgram('{"version":1,"images":[{}],"brushes":{},"zones":{},"marks":[]}'), /unreferenced/);
  assert.throws(() => bakeMarks(program([]), {width: 256, height: 256}), /13-component/);
  assert.throws(() => compileMarkProgram(program([{kind: 'stroke', brush: 'tip', color: [1, 0, 0], radius: .001,
    spacing: 1 / MARK_LIMITS.dabs, points: [{at: [0, 0]}, {at: [1, 0]}]}])), /dab budget/);
  assert.throws(() => compileMarkProgram(program([{kind: 'stroke', brush: 'tip', color: [1, 0, 0], radius: 1e-200,
    points: [{at: [0, 0]}]}])), /invertible/);
});

test('sparse author arrays are rejected at the mark boundary before compilation', () => {
  const color = [.2, .4, .6]; delete color[1];
  assert.throws(() => markProgram(program([dab(color)])), /finite/);
  const transform = [...identity]; delete transform[4];
  assert.throws(() => markProgram(program([dab([.2, .4, .6], {transform})])), /finite/);
  const marks = [dab([.2, .4, .6])]; delete marks[0];
  assert.throws(() => markProgram(program(marks)), /mark must be a plain object/);
  const points = [{at: [0, 0]}]; delete points[0];
  assert.throws(() => markProgram(program([{kind: 'stroke', brush: 'tip', color: [.2, .4, .6], radius: .1, points}])), /stroke point must be a plain object/);
  const bounds = [0, 0, 1, 1]; delete bounds[2];
  assert.throws(() => bakeMarks(program([]), {width: 1, height: 1, bounds}), /bounds must be finite/);
  const empty = bakeMarks(program([]), {width: 1, height: 1});
  assert.throws(() => applyMarkBake(surface.paint(), {...empty, bounds}), /bounds must be finite/);
  assert.throws(() => applyMarkBake(surface.paint(), {...empty, channels: Array(1)}), /Invalid mark finish channel/);
});

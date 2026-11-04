import test from 'node:test';
import assert from 'node:assert/strict';
import {
  color, scalar, surface, domain, named, inDomain, instantiate, expressionGraph, graphExpression,
  materialGraph, patchGraph, compileGraph, serializeGraph, parseExpressionGraph, createFieldSampler,
} from '../src/core.mjs';
import {linearToOklab} from '../src/core/color.mts';
import {adjustColorSample} from '../src/core/color-sample.mts';

const close = (a, b, tolerance = 1e-11) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
const vectorClose = (a, b, tolerance) => a.forEach((value, index) => close(value, b[index], tolerance));
const sample = (expression, context) => createFieldSampler(expression)(context);
const material = expression => materialGraph(surface.material(expression));
const read = (graph, id) => graph.nodes.find(node => node.id === id);

test('Oklab and OKLCH authoring lower once to the existing editable Color literal', () => {
  const coordinates = [.65, -.1, .08], authored = color.oklab(coordinates);
  coordinates[0] = .9;
  assert.equal(authored.kind, 'color');
  vectorClose(linearToOklab(authored.value), [.65, -.1, .08]);
  const polar = color.oklch([.65, .1, 90]);
  vectorClose(linearToOklab(polar.value), [.65, 0, .1]);
  const graph = expressionGraph(named('ink', polar));
  assert.equal(graph.nodes.length, 1);
  assert.deepEqual(read(patchGraph(graph, {ink: {value: [-.2, .4, 1.2]}}), 'ink').value, [-.2, .4, 1.2]);
  assert.throws(() => color.oklab([.2, .3]), /three components/);
  assert.throws(() => color.oklab([.2, , .3]), /finite/);
  assert.throws(() => color.oklch([.5, -.1, 20]), /nonnegative/);
  assert.throws(() => color.oklch([.5, .1, Infinity]), /finite/);
});

test('adjustment defaults are explicit typed scalar ports and options are snapshotted', () => {
  const input = named('ink', color.srgb('#345678'));
  const options = {lightness: .1};
  const adjusted = named('adjusted', color.adjust(input, options));
  options.lightness = .4;
  assert.equal(adjusted.input, input);
  assert.equal(adjusted.lightness.value, .1);
  assert.equal(adjusted.chroma.value, 1);
  assert.equal(adjusted.hue.value, 0);
  const graph = expressionGraph(adjusted);
  assert.deepEqual(parseExpressionGraph(serializeGraph(graph)), graph);
  assert.deepEqual(sample(graphExpression(graph)), sample(adjusted));
  assert.throws(() => color.adjust(input, {saturation: 1}), /Unknown color adjustment/);
  assert.throws(() => expressionGraph(color.adjust(scalar.axis())), /expects color/);
  for (const control of ['lightness', 'chroma', 'hue']) {
    assert.throws(() => expressionGraph(color.adjust(input, {[control]: input})), /expects scalar/);
    assert.throws(() => expressionGraph(color.adjust(input, {[control]: NaN})), /finite/);
  }
  assert.throws(() => patchGraph(graph, {adjusted: {hue: 'other'}}), /structural/);
});

test('Cartesian color adjustments translate lightness and rotate/scale chroma without clipping', () => {
  const source = color.oklab([.6, .1, .05]);
  const transformed = sample(color.adjust(source, {lightness: .2, chroma: 2, hue: 90}));
  vectorClose(linearToOklab(transformed.value), [.8, -.1, .2]);
  const extended = sample(color.adjust(source, {lightness: .8, chroma: 3})).value;
  assert(extended.some(value => value > 1 || value < 0));
  const neutral = sample(color.adjust(color.oklab([.5, 0, 0]), {hue: 137, chroma: 4})).value;
  vectorClose(neutral, [.125, .125, .125]);
  vectorClose(sample(color.adjust(source, {chroma: -1})).value,
    sample(color.adjust(source, {hue: 180})).value);
  vectorClose(linearToOklab(sample(color.adjust(source, {chroma: 0})).value), [.6, 0, 0]);
});

test('hue degrees are periodic in both authored literals and spatial adjustments', () => {
  const source = color.oklch([.7, .12, 25]);
  for (const rotation of [-1080, -360, 360, 1080]) {
    vectorClose(color.oklch([.7, .12, 25 + rotation]).value, source.value);
    vectorClose(sample(color.adjust(source, {hue: 73 + rotation})).value,
      sample(color.adjust(source, {hue: 73})).value);
  }
  vectorClose(sample(color.adjust(source, {hue: -450})).value,
    sample(color.adjust(source, {hue: 270})).value);
});

test('literal identity folds exactly while editable controls at identity retain bindings', () => {
  const input = color.linear([-.2, .4, 1.2]);
  const plain = compileGraph(material(input));
  for (const hue of [0, 360, -720]) {
    const adjusted = color.adjust(input, {hue});
    assert.deepEqual(sample(adjusted), sample(input));
    assert.equal(compileGraph(material(adjusted)).programKey, plain.programKey);
  }
  const live = named('adjusted', color.adjust(input, {
    lightness: named('lightness', scalar.parameter(0)),
    chroma: named('chroma', scalar.parameter(1)),
    hue: named('hue', scalar.parameter(0)),
  }));
  const graph = material(live), before = compileGraph(graph);
  assert(before.nodes.some(node => node.kind === 'colorAdjust'));
  assert.equal(before.bindings.length, 4);
  assert.equal(before.cost.uniformScalars, 6);
  const after = patchGraph(graph, {lightness: {value: -.1}, chroma: {value: .8}, hue: {value: 30}});
  assert.equal(compileGraph(after).structure, before.structure);
  assert.notDeepEqual(sample(graphExpression(expressionGraph(after), 'adjusted')).value, sample(live).value);
});

test('nonidentity nested adjustments keep their authored order and graph structure', () => {
  const source = color.oklab([.7, .12, -.04]);
  const nested = color.adjust(color.adjust(source, {lightness: -.1, chroma: .8, hue: 35}),
    {lightness: .2, chroma: 1.5, hue: -20});
  assert.equal(compileGraph(material(nested)).nodes.filter(node => node.kind === 'colorAdjust').length, 2);
  vectorClose(sample(nested).value, sample(color.adjust(source, {lightness: .1, chroma: 1.2, hue: 15})).value);
});

test('adjustment control fields retain DAG sharing, domain binding and scoped parameters', () => {
  const common = named('control', scalar.axis('x'));
  const adjusted = color.adjust(color.oklab([.6, .1, .05]), {lightness: common, chroma: common, hue: common});
  const frame = domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .2, 0, 0, 1]);
  const bound = inDomain(adjusted, frame);
  assert.equal(bound.lightness, bound.chroma);
  assert.equal(bound.chroma, bound.hue);
  assert.equal(bound.lightness.domain, frame);
  assert.equal(expressionGraph(bound).nodes.filter(node => node.kind === 'axis').length, 1);
  const template = color.adjust(color.oklch([.6, .1, 250]), {hue: named('hue', scalar.parameter(15))});
  const left = instantiate(template, {prefix: 'left'}), right = instantiate(template, {prefix: 'right'});
  const graph = expressionGraph(color.mix(left, right, .5));
  const changed = patchGraph(graph, {left_hue: {value: 65}});
  assert.equal(read(changed, 'right_hue').value, 15);
  assert.notDeepEqual(sample(graph).value, sample(changed).value);
});

for (const hueBase of [27, 180, -180, 540]) {
  test(`color adjustment tangents include every varying input at hue ${hueBase}°`, () => {
    const x = scalar.axis('x'), y = scalar.axis('y'), z = scalar.axis('z');
    const input = color.mix(color.linear([-.03, .18, .47]), color.linear([.73, .32, .11]), scalar.ramp(z, -1, 1));
    const adjusted = color.adjust(input, {
      lightness: scalar.multiply(y, .1), chroma: scalar.add(1.2, scalar.multiply(z, .3)),
      hue: scalar.add(hueBase, scalar.multiply(x, 43)),
    });
    const context = {position: [0, -.24, .31], dx: [.3, -.2, .4], dy: [-.4, .3, .1]};
    const sampler = createFieldSampler(adjusted), result = sampler(context), step = 1e-5;
    for (const derivative of ['dx', 'dy']) {
      const offset = sign => context.position.map((value, index) => value + sign * step * context[derivative][index]);
      const high = sampler({...context, position: offset(1)}), low = sampler({...context, position: offset(-1)});
      vectorClose(result[derivative], high.value.map((value, index) => (value - low.value[index]) / (2 * step)), 2e-8);
    }
  });
}

test('adjustments retain the existing Oklab zero-LMS tangent convention', () => {
  const uniform = value => ({value, dx: 0, dy: 0}), zero = [0, 0, 0];
  const black = adjustColorSample({value: zero, dx: zero, dy: zero}, uniform(.2), uniform(1), uniform(40));
  vectorClose(black.value, [.008, .008, .008]);
  assert.deepEqual(black.dx, zero);
  assert.throws(() => adjustColorSample({value: zero, dx: [1, 0, 0], dy: zero},
    uniform(.2), uniform(1), uniform(40)), /undefined at a zero LMS component/);
});

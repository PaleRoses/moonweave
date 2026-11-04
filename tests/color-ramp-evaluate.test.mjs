import test from 'node:test';
import assert from 'node:assert/strict';
import {
  color, scalar, domain, surface, named, materialGraph, evaluateColor, evaluateDomain, patchGraph,
} from '../src/core.mjs';

const close = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
const graphFor = expression => materialGraph(surface.material(named('pigment', expression)));
const positionAt = value => ({position: [value, .13, -.27], dx: [1, 0, 0], dy: [.25, .5, 0]});

test('sample vectors reject sparse components at the shared evaluation boundary', () => {
  const graph = graphFor(color.linear([.2, .3, .4]));
  const sparse = [1, , 0];
  for (const key of ['position', 'normal', 'dx', 'dy', 'normalDx', 'normalDy']) {
    assert.throws(() => evaluateColor(graph, 'pigment', {[key]: sparse}), /must be finite/);
    assert.throws(() => evaluateDomain(graph, undefined, {[key]: sparse}), /must be finite/);
  }
});

test('extended color values survive expression composition and CPU sampling', () => {
  const graph = graphFor(color.mix(color.linear([-1, .5, 2]), color.linear([2, -.5, -1]), .25));
  assert.deepEqual(evaluateColor(graph, 'pigment').value, [-.25, .25, 1.25]);
});

test('mix and ramp sampling skip unused color branches, including exact knots', () => {
  const giant = domain.transform([1e20, 0, 0, 0, 0, 1e20, 0, 0, 0, 0, 1e20, 0, 0, 0, 0, 1]);
  const unavailable = color.mix(color.linear([0, 0, 0]), color.linear([1, 1, 1]), scalar.axis('x', giant));
  const first = color.linear([.2, .3, .4]), last = color.linear([.7, .6, .5]);
  const context = {position: [1e20, 1e20, 1e20]};
  const mixed = graphFor(color.mix(first, unavailable, named('weight', scalar.parameter(0))));
  assert.deepEqual(evaluateColor(mixed, 'pigment', context).value, [.2, .3, .4]);
  assert.throws(() => evaluateColor(patchGraph(mixed, {weight: {value: .5}}), 'pigment', context), /transformed position/);
  const ramp = graphFor(color.ramp(named('weight', scalar.parameter(0)), [[0, first], [1, unavailable], [2, last]]));
  assert.deepEqual(evaluateColor(ramp, 'pigment', context).value, [.2, .3, .4]);
  for (const value of [2, 3]) {
    assert.deepEqual(evaluateColor(patchGraph(ramp, {weight: {value}}), 'pigment', context).value, [.7, .6, .5]);
  }
  assert.throws(() => evaluateColor(patchGraph(ramp, {weight: {value: .5}}), 'pigment', context), /transformed position/);
});

test('same-reference mix and ramp identities do not sample their unused scalar input', () => {
  const giant = domain.transform([1e20, 0, 0, 0, 0, 1e20, 0, 0, 0, 0, 1e20, 0, 0, 0, 0, 1]);
  const unavailable = scalar.axis('x', giant), shared = color.linear([.2, .3, .4]);
  const context = {position: [1e20, 1e20, 1e20]};
  for (const expression of [color.mix(shared, shared, unavailable, {space: 'oklab'}),
    color.ramp(unavailable, [[0, shared], [1, shared], [2, shared]], {space: 'oklab'})]) {
    assert.deepEqual(evaluateColor(graphFor(expression), 'pigment', context).value, [.2, .3, .4]);
  }
});

test('ramps interpolate in their authored coordinate interval and clamp to exact stops', () => {
  const values = [[.1, .2, .3], [.5, .6, .7], [.9, .8, .4]];
  const graph = graphFor(color.ramp(scalar.axis('x'), values.map((value, index) => [index * 2 - 2, color.linear(value)])));
  for (const [x, expected] of [[-4, values[0]], [-2, values[0]], [0, values[1]], [2, values[2]], [4, values[2]]]) {
    const sample = evaluateColor(graph, 'pigment', positionAt(x));
    assert.deepEqual(sample.value, expected);
    assert.deepEqual(sample.dx, [0, 0, 0]);
  }
  const midpoint = evaluateColor(graph, 'pigment', positionAt(-1));
  midpoint.value.forEach((value, index) => close(value, (values[0][index] + values[1][index]) / 2));
  midpoint.dx.forEach(value => close(value, .2));
});

test('exact ramp stops preserve their own spatial differentials', () => {
  const middle = color.mix(color.linear([0, 0, 0]), color.linear([1, 1, 1]), scalar.axis('y'));
  const graph = graphFor(color.ramp(scalar.axis('x'), [[-1, color.linear([1, 0, 0])], [0, middle], [1, color.linear([0, 1, 0])]]));
  const sample = evaluateColor(graph, 'pigment', {position: [0, .5, 0], dx: [1, 2, 0], dy: [0, 3, 0]});
  assert.deepEqual(sample.value, [.5, .5, .5]);
  assert.deepEqual(sample.dx, [2, 2, 2]);
  assert.deepEqual(sample.dy, [3, 3, 3]);
});

test('constant ramps choose the left interval and the authored color at a knot', () => {
  const values = [[.1, .2, .3], [.5, .6, .7], [.9, .8, .4]];
  const graph = graphFor(color.ramp(scalar.axis('x'), values.map((value, index) => [index, color.linear(value)]), {interpolation: 'constant'}));
  for (const [x, index] of [[-.2, 0], [.2, 0], [.999, 0], [1, 1], [1.001, 1], [2, 2], [2.1, 2]]) {
    const result = evaluateColor(graph, 'pigment', positionAt(x));
    assert.deepEqual(result.value, values[index]);
    assert.deepEqual(result.dx, [0, 0, 0]);
  }
});

for (const space of ['linear-rgb', 'oklab']) for (const interpolation of ['linear', 'smoothstep']) {
  test(`${space}/${interpolation}: graph ramp derivatives include both moving colors and interval weight`, () => {
    const grain = scalar.noise({seed: 37});
    const first = color.mix(color.linear([.1, .5, .8]), color.linear([.9, .2, .1]), grain, {space});
    const second = color.mix(color.linear([.4, .9, .1]), color.linear([.7, .3, .6]), scalar.ramp(scalar.axis('y'), -1, 1), {space});
    const third = color.linear([.6, .2, .7]);
    const graph = graphFor(color.ramp(scalar.axis('x'), [[-1, first], [.4, second], [1.5, third]], {space, interpolation}));
    const context = {position: [.13, -.21, .57], dx: [.3, -.1, .2], dy: [-.2, .4, .1]}, step = 1e-5;
    const sample = evaluateColor(graph, 'pigment', context);
    for (const derivative of ['dx', 'dy']) {
      const position = sign => context.position.map((value, index) => value + sign * context[derivative][index] * step);
      const high = evaluateColor(graph, 'pigment', {...context, position: position(1)});
      const low = evaluateColor(graph, 'pigment', {...context, position: position(-1)});
      sample[derivative].forEach((value, index) => close(value, (high.value[index] - low.value[index]) / (2 * step), 5e-8));
    }
  });
}

test('Oklab ramp black stops remain finite and parameter edits change samples', () => {
  const graph = graphFor(color.ramp(scalar.axis('x'), [[0, color.linear([0, 0, 0])], [1, color.linear([1, 1, 1])]], {space: 'oklab'}));
  const before = evaluateColor(graph, 'pigment', positionAt(.5));
  before.value.forEach(value => close(value, .125, 1e-7));
  before.dx.forEach(value => close(value, .75, 1e-6));
  const after = evaluateColor(patchGraph(graph, {pigment: {positions: [0, 2]}}), 'pigment', positionAt(.5));
  after.value.forEach(value => close(value, .015625, 1e-7));
  assert.deepEqual(evaluateColor(graph, 'pigment', positionAt(0)).value, [0, 0, 0]);
});

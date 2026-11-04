import test from 'node:test';
import assert from 'node:assert/strict';
import {mask} from '../src/core/masks.mts';
import {
  scalar, color, domain, surface, expressionGraph, graphExpression,
  createFieldSampler, compileGraph, serializeGraph, parseExpressionGraph, inDomain,
} from '../src/core.mjs';

const close = (actual, expected, tolerance = 1e-7) =>
  assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('interval masks have finite support, an exact plateau and inward C1 edges', () => {
  const sample = createFieldSampler(mask.interval(scalar.axis('x'), -2, 3, {feather: .5}));
  for (const x of [-3, -2, 3, 4]) {
    assert.deepEqual(sample({position: [x, 0, 0], dx: [1, 0, 0]}), {value: 0, dx: 0, dy: 0});
  }
  for (const x of [-1.5, 0, 2.5]) {
    assert.deepEqual(sample({position: [x, 0, 0], dx: [1, 0, 0]}), {value: 1, dx: 0, dy: 0});
  }
  assert.deepEqual(sample({position: [-1.75, 0, 0], dx: [1, 0, 0]}), {value: .5, dx: 3, dy: 0});
  assert.deepEqual(sample({position: [2.75, 0, 0], dx: [1, 0, 0]}), {value: .5, dx: -3, dy: 0});
});

test('interval defaults feather one tenth of the input range and accepts scalar literals', () => {
  const sample = createFieldSampler(mask.interval(scalar.axis('x'), -2, 3));
  close(sample({position: [-1.75, 0, 0]}).value, .5);
  assert.deepEqual(createFieldSampler(mask.interval(0, -1, 1))(), {value: 1, dx: 0, dy: 0});
  const triangular = createFieldSampler(mask.interval(scalar.axis('x'), -1, 1, {feather: 1}));
  assert.deepEqual(triangular({position: [0, 0, 0], dx: [1, 0, 0]}), {value: 1, dx: 0, dy: 0});
});

test('chisel masks preserve independent side softness and remain bounded at huge coordinates', () => {
  const feather = [.2, .4, .8];
  const expression = mask.chisel({feather}), sample = createFieldSampler(expression);
  assert.equal(Object.isFrozen(feather), false);
  feather[0] = .9;
  for (const position of [[.9, 0, 0], [0, .8, 0], [0, 0, .6]]) close(sample({position}).value, .5);
  close(sample({position: [.9, .8, .6]}).value, .125);
  for (const position of [[1e20, 0, 0], [0, -1e20, 0], [0, 0, 1e20]]) {
    assert.deepEqual(sample({position, dx: [1, 1, 1], dy: [-1, 1, -1]}), {value: 0, dx: 0, dy: 0});
  }
  const defaultSample = createFieldSampler(mask.chisel());
  close(defaultSample({position: [.9, .9, .9]}).value, .125);
});

test('a transformed chisel carries the full product derivative', () => {
  const frame = domain.transform([1.4, -.2, 0, 0, .3, .8, 0, 0, 0, 0, .7, 0, -.1, .15, -.2, 1]);
  const sample = createFieldSampler(mask.chisel({domain: frame, feather: [.3, .2, .4]}));
  const context = {position: [.53, 1.06, 1.5], dx: [.2, -.15, .1], dy: [-.12, .17, .08]};
  const result = sample(context), epsilon = 1e-5;
  assert(result.value > 0 && result.value < 1);
  assert(Math.abs(result.dx) > 1e-3 && Math.abs(result.dy) > 1e-3);
  for (const axis of ['dx', 'dy']) {
    const displaced = sign => sample({position: context.position.map((value, index) =>
      value + sign * epsilon * context[axis][index])}).value;
    close(result[axis], (displaced(1) - displaced(-1)) / (2 * epsilon));
  }
});

test('masks stay ordinary scalar graphs across serialization and domain binding', () => {
  const frame = domain.transform([1, .2, 0, 0, 0, 2, 0, 0, .1, 0, 1, 0, -.3, .2, 0, 1]);
  const direct = mask.chisel({domain: frame});
  const bound = inDomain(mask.chisel(), frame);
  const restored = graphExpression(parseExpressionGraph(serializeGraph(bound)));
  const context = {position: [.7, .3, .2], dx: [.1, .2, .3], dy: [-.2, .1, 0]};
  assert.deepEqual(createFieldSampler(bound)(context), createFieldSampler(direct)(context));
  assert.deepEqual(createFieldSampler(restored)(context), createFieldSampler(direct)(context));
  const graph = expressionGraph(mask.chisel());
  assert.equal(graph.nodes.length, 17);
  assert.deepEqual(new Set(graph.nodes.map(node => node.kind)), new Set(['axis', 'ramp', 'complement', 'multiply']));
  const plan = compileGraph(surface.material(color.mix(color.srgb('#203040'), color.srgb('#d8b885'), bound)));
  assert.equal(plan.cost.proceduralSamples, 0);
  assert.equal(plan.cost.textureReads, 0);
});

test('mask authoring rejects invalid support, softness and unrepresentable ramp edges', () => {
  for (const [low, high] of [[1, 1], [2, 1], [NaN, 1], [-Infinity, 1]]) {
    assert.throws(() => mask.interval(scalar.axis('x'), low, high), RangeError);
  }
  for (const feather of [0, -1, 1.01, NaN, Infinity]) {
    assert.throws(() => mask.interval(scalar.axis('x'), -1, 1, {feather}), RangeError);
  }
  assert.throws(() => mask.interval(scalar.axis('x'), 1e8, 1e8 + 8, {feather: 1}), /float32/);
  assert.throws(() => mask.interval(scalar.axis('x'), -1, 1, {unknown: 1}), /Unknown/);
  for (const feather of [[.2, .2], [.2, .2, .2, .2], 'soft', null]) {
    assert.throws(() => mask.chisel({feather}), TypeError);
  }
  assert.throws(() => mask.chisel({feather: [.2, 0, .2]}), RangeError);
  assert.throws(() => mask.chisel({feather: [.2, , .2]}), RangeError);
  assert.throws(() => mask.chisel({unknown: 1}), /Unknown/);
});

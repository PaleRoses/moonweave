import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scalar, domain, surface, named, materialGraph, patchGraph, compileGraph,
  evaluateScalar, evaluateDomain, inDomain, serializeGraph, parseGraph,
} from '../src/core.mjs';
import {NOISE_PERIOD, sampleNoise} from '../src/core/noise.mts';

const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
const graphFor = field => materialGraph(surface.channels(surface.paint(), {roughness: named('grain', field)}));
const delta = (position, direction, step) => position.map((value, i) => value + direction[i] * step);
const fixtures = [
  {position: [0, 0, 0], seed: 0, value: 0.49947673082351685},
  {position: [0, 0, 0], seed: 0xffffffff, value: 0.8572669625282288},
  {position: [.25, .5, .75], seed: 0, value: 0.43801752859189946},
  {position: [-.25, -.5, -.75], seed: 1, value: 0.6584698800245405},
  {position: [65535.75, 2.125, -65536.5], seed: 29031, value: 0.5487114247073279},
];

test('value-noise samples retain the documented deterministic field', () => {
  for (const {position, seed, value} of fixtures) {
    assert.equal(sampleNoise(position, seed).value, value);
    assert.deepEqual(sampleNoise(position, seed), sampleNoise(position, seed));
  }
  for (let i = 0; i < 128; i++) {
    const position = [Math.sin(i) * 13, Math.cos(i * .7) * 9, i * .391 - 20];
    for (const seed of [0, 1, 29031, 0xffffffff]) {
      const sample = sampleNoise(position, seed);
      assert(sample.value >= 0 && sample.value <= 1);
      assert(sample.gradient.every(Number.isFinite));
    }
  }
});

test('noise is periodic per axis, including negative coordinates and the wrap seam', () => {
  assert.equal(NOISE_PERIOD, 65536);
  for (const {position, seed} of fixtures) {
    const source = sampleNoise(position, seed);
    for (let axis = 0; axis < 3; axis++) {
      for (const periods of [-2, -1, 1, 2]) {
        const target = sampleNoise(position.map((v, i) => v + (axis === i ? periods * NOISE_PERIOD : 0)), seed);
        close(source.value, target.value);
        source.gradient.forEach((value, i) => close(value, target.gradient[i]));
      }
    }
  }
  const at = sampleNoise([0, .25, -.5], 71);
  for (const x of [-1e-5, 1e-5, NOISE_PERIOD - 1e-5, NOISE_PERIOD + 1e-5]) {
    const beside = sampleNoise([x, .25, -.5], 71);
    close(at.value, beside.value, 1e-12);
    close(beside.gradient[0], 0, 1e-8);
  }
});

test('analytic noise gradients agree with central finite differences', () => {
  const positions = [...fixtures.map(item => item.position), [0, 1, -2], [-1e-4, .27, .61]];
  for (let i = 0; i < 14; i++) positions.push([Math.sin(i) * 3, Math.cos(i * .3) * 2, i * .193]);
  const step = 1e-5;
  for (const position of positions) for (const seed of [0, 29031, 0xffffffff]) {
    const sample = sampleNoise(position, seed);
    for (let axis = 0; axis < 3; axis++) {
      const direction = [0, 0, 0]; direction[axis] = 1;
      const high = sampleNoise(delta(position, direction, step), seed).value;
      const low = sampleNoise(delta(position, direction, -step), seed).value;
      close(sample.gradient[axis], (high - low) / (2 * step), 4e-7);
    }
  }
});

test('noise wraps large finite coordinates before any integer hash conversion', () => {
  const big = Math.fround(3.4028234663852886e38);
  const reference = sampleNoise([0, 0, 0], 0xffffffff);
  for (const position of [[big, -big, big], [2 ** 40, -(2 ** 50), 2 ** 60]]) {
    assert.deepEqual(sampleNoise(position, 0xffffffff), reference);
  }
});

test('noise seed is an editable uint32 with a stable program and isolated CPU revisions', () => {
  const original = graphFor(scalar.noise()), context = {position: [.25, -.5, .75], dx: [.2, .1, 0], dy: [0, -.3, .1]};
  const first = evaluateScalar(original, 'grain', context), plan = compileGraph(original);
  const edited = patchGraph(original, {grain: {seed: 0xffffffff}});
  const changed = evaluateScalar(edited, 'grain', context), next = compileGraph(edited);
  assert.notEqual(first.value, changed.value);
  assert.deepEqual(evaluateScalar(original, 'grain', context), first);
  assert.equal(next.structure, plan.structure);
  assert.equal(next.programKey, plan.programKey);
  assert.deepEqual(plan.ranges[plan.nodes.find(node => node.kind === 'noise').id], [0, 1]);
  assert.deepEqual(evaluateScalar(parseGraph(serializeGraph(edited)), 'grain', context), changed);
  for (const seed of [-1, .5, 0x100000000, NaN, Infinity]) {
    assert.throws(() => graphFor(scalar.noise({seed})), /seed/);
    assert.throws(() => patchGraph(original, {grain: {seed}}), /seed/);
  }
});

test('noise point sampling preserves values when screen differentials change', () => {
  const graph = graphFor(scalar.noise({seed: 72})), position = [.123, -.87, 2.625];
  const point = evaluateScalar(graph, 'grain', {position});
  const broad = evaluateScalar(graph, 'grain', {position, dx: [8, 0, 0], dy: [0, 5, 0]});
  assert.equal(point.value, broad.value);
  assert.equal(point.dx, 0); assert.equal(point.dy, 0);
  const expected = sampleNoise(position, 72);
  close(broad.dx, expected.gradient[0] * 8);
  close(broad.dy, expected.gradient[1] * 5);
  assert(Object.isFrozen(broad));
});

test('noise differentials follow transformed domains and whole-expression binding', () => {
  const parent = domain.transform([1, 0, .2, 0, .3, 1, 0, 0, 0, 0, 1, 0, -.7, .5, 1.2, 1]);
  const frame = domain.transform([2, 0, 0, 0, 0, -.7, 0, 0, 0, 0, .3, 0, .1, -.2, .3, 1], parent);
  const graph = graphFor(scalar.noise({seed: 29, domain: frame}));
  const bound = graphFor(inDomain(scalar.noise({seed: 29}), frame));
  assert.equal(serializeGraph(graph), serializeGraph(bound));
  const context = {position: [.317, -.439, .21], dx: [.4, .2, -.1], dy: [-.1, .3, .4]};
  const sampled = evaluateScalar(graph, 'grain', context);
  const frameId = graph.nodes.find(node => node.id === 'grain').domain;
  const mapped = evaluateDomain(graph, frameId, context), reference = sampleNoise(mapped.position, 29);
  close(sampled.value, reference.value);
  for (const axis of ['dx', 'dy']) {
    const step = 1e-5;
    const high = evaluateScalar(graph, 'grain', {...context, position: delta(context.position, context[axis], step)}).value;
    const low = evaluateScalar(graph, 'grain', {...context, position: delta(context.position, context[axis], -step)}).value;
    close(sampled[axis], (high - low) / (2 * step), 2e-8);
  }
});

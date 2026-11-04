import test from 'node:test';
import assert from 'node:assert/strict';
import {color, scalar, surface, named, materialGraph, patchGraph, evaluateColor, evaluateScalar} from '../src/core.mjs';

const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
const graphFor = expression => materialGraph(surface.material(named('pigment', expression)));

test('color evaluation interpolates decoded linear RGB and snapshots edits', () => {
  const expression = color.mix(named('dark', color.srgb('#404040')), color.linear([1, .5, .25]), scalar.parameter(.5));
  const graph = graphFor(expression), before = evaluateColor(graph, 'pigment');
  const dark = ((64 / 255 + .055) / 1.055) ** 2.4;
  before.value.forEach((v, i) => close(v, (dark + [1, .5, .25][i]) / 2));
  assert.deepEqual(before.dx, [0, 0, 0]); assert.deepEqual(before.dy, [0, 0, 0]);
  assert(Object.isFrozen(before)); assert(Object.isFrozen(before.value));
  const edited = patchGraph(graph, {dark: {value: [0, 0, 0]}});
  assert.deepEqual(evaluateColor(edited, 'pigment').value, [.5, .25, .125]);
  assert.deepEqual(evaluateColor(graph, 'pigment'), before);
  assert.throws(() => evaluateScalar(graph, 'pigment'), /Expected scalar/);
  assert.throws(() => evaluateColor(graph, graph.output), /Expected color/);
});

test('color mix applies the product rule to both variable colors and its mask', () => {
  const grain = scalar.noise({seed: 311}), axis = scalar.ramp(scalar.axis('y'), -1, 1);
  const first = color.mix(color.linear([.1, .5, .8]), color.linear([.9, .2, .1]), grain);
  const second = color.mix(color.linear([.4, .9, .1]), color.linear([.7, .3, .6]), axis);
  const graph = graphFor(color.mix(first, second, scalar.ramp(scalar.axis('x'), -2, 2)));
  const context = {position: [.13, -.21, .57], dx: [.3, -.1, .2], dy: [-.2, .4, .1]};
  const sample = evaluateColor(graph, 'pigment', context), step = 1e-5;
  for (const derivative of ['dx', 'dy']) {
    const position = sign => context.position.map((v, i) => v + sign * context[derivative][i] * step);
    const high = evaluateColor(graph, 'pigment', {...context, position: position(1)});
    const low = evaluateColor(graph, 'pigment', {...context, position: position(-1)});
    sample[derivative].forEach((v, i) => close(v, (high.value[i] - low.value[i]) / (2 * step), 2e-9));
  }
});

test('color mix clamps masks and chooses zero mask derivative at either endpoint', () => {
  const a = [.1, .4, .7], b = [.9, .2, .3];
  const graph = graphFor(color.mix(color.linear(a), color.linear(b), scalar.axis('x')));
  for (const x of [-3, 0, 1, 4]) {
    const result = evaluateColor(graph, 'pigment', {position: [x, 0, 0], dx: [1, 0, 0], dy: [2, 0, 0]});
    result.value.forEach((v, i) => close(v, (x <= 0 ? a : b)[i]));
    assert.deepEqual(result.dx, [0, 0, 0]); assert.deepEqual(result.dy, [0, 0, 0]);
  }
  const tiny = graphFor(color.mix(color.linear([1, 1, 1]), color.linear([1e-20, 1e-25, 1e-30]), 1));
  assert.deepEqual(evaluateColor(tiny, 'pigment').value, [1e-20, 1e-25, 1e-30]);
});

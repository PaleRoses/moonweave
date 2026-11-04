import test from 'node:test';
import assert from 'node:assert/strict';
import {surface, color, scalar, named, materialGraph, compileGraph, patchGraph, parseGraph, serializeGraph} from '../src/core.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';

const base = () => surface.material(color.linear([.1, .2, .3]));

test('associated deposition is one typed operation with complete independent channel pairs', () => {
  const graph = materialGraph(surface.deposit(base(), color.linear([.2, .1, .04]), .5,
    {roughness: {value: .15, coverage: .25}, clearcoat: {value: .1, coverage: .4}}));
  const node = graph.nodes.at(-1);
  assert.equal(node.kind, 'deposit');
  assert.equal(node.opacity, undefined);
  assert.equal(serializeGraph(parseGraph(serializeGraph(graph))), serializeGraph(graph));
  const bad = structuredClone(graph); delete bad.nodes.at(-1).roughnessMask;
  assert.throws(() => materialGraph(bad), /roughness and roughnessMask must be supplied together/);
  const shader = generateSurfaceShader(compileGraph(graph)).evaluate;
  assert.match(shader, /\.color = clamp\(.+\) \+ \(1.0 - mwAlpha_/);
  assert.doesNotMatch(shader, /\.slope [+=*]/);
});

test('opacity analysis preserves guaranteed opaque deposits and updates live coverage', () => {
  const graph = materialGraph(surface.deposit(base(), color.linear([0, 0, 0]), 0,
    {opacity: {value: named('associatedOpacity', scalar.parameter(1)), coverage: named('coverage', scalar.parameter(1))}}));
  assert.deepEqual(compileGraph(graph).opacityRange, [1, 1]);
  const half = patchGraph(graph, {associatedOpacity: {value: .2}, coverage: {value: .5}});
  assert.deepEqual(compileGraph(half).opacityRange, [.7, .7]);
  assert.equal(compileGraph(half).structure, compileGraph(graph).structure);
  assert.deepEqual(compileGraph(patchGraph(half, {coverage: {value: 0}})).opacityRange, [1, 1]);
});

test('opacity intervals include the interior coverage maximum', () => {
  const varying = scalar.ramp(scalar.axis('x'), 0, 1);
  const prior = surface.channels(base(), {opacity: .3});
  const graph = materialGraph(surface.deposit(prior, color.linear([0, 0, 0]), 0,
    {opacity: {value: .4, coverage: varying}}));
  const [low, high] = compileGraph(graph).opacityRange;
  assert.equal(low, .3);
  assert(Math.abs(high - .58) < 1e-15);
  for (let i = 0; i <= 100; i++) {
    const a = i / 100, observed = Math.min(.4, a) + (1 - a) * .3;
    assert(observed >= low - 1e-15 && observed <= high + 1e-15);
  }
});

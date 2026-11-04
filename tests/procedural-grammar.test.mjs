import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scalar, color, surface, domain, named, inDomain,
  materialGraph, patchGraph, parseGraph, serializeGraph, foldGraph,
} from '../src/core.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const graphOf = value => materialGraph(surface.material(value));
const node = (graph, id) => graph.nodes.find(value => value.id === id);

function composition() {
  const grain = named('grain', scalar.noise({seed: 41}));
  const ink = named('ink', color.srgb('#284d58'));
  const glaze = color.mix(ink, color.linear([.6, .8, .9]), grain);
  return {grain, ink, glaze, expression: surface.channels(surface.material(glaze), {roughness: grain})};
}

test('the procedural grammar shares a scalar across color and finish without requiring facets', () => {
  const graph = materialGraph(composition().expression);
  assert.equal(graph.version, 2);
  assert.equal(graph.nodes.filter(value => value.kind === 'noise').length, 1);
  assert.equal(graph.nodes.some(value => value.kind === 'paint' || value.kind === 'facets'), false);
  assert.equal(graph.nodes.find(value => value.kind === 'colorMix').mask, 'grain');
  assert.equal(node(graph, graph.output).values.roughness, 'grain');
  assert.equal(serializeGraph(parseGraph(serializeGraph(graph))), serializeGraph(graph));
  assert.equal(parseGraph(serializeGraph(materialGraph('moonstone'))).version, 2);
});

test('linear color owns a snapshot and sRGB decoding has one explicit boundary', () => {
  const value = [.1, .3, .7], ink = color.linear(value);
  value[1] = .9;
  assert.equal(Object.isFrozen(value), false);
  assert.deepEqual(ink.value, [.1, .3, .7]);
  assert.equal(Object.isFrozen(ink.value), true);
  assert.deepEqual(color.srgb('#000000').value, [0, 0, 0]);
  assert.deepEqual(color.srgb('#FFFFFF').value, [1, 1, 1]);
  const gray = color.srgb('#808080').value;
  assert(Math.abs(gray[0] - .21586050011389926) < 1e-15);
  assert.equal(gray[0], gray[1]);
  assert.equal(gray[1], gray[2]);
  assert.notEqual(gray[0], 128 / 255);
  for (const invalid of ['red', '#fff', 'ffffff', '#11223344', '#gg0000', 0]) {
    assert.throws(() => color.srgb(invalid), /six-digit hex/);
  }
});

test('new sorts reject implicit conversions, callbacks and invalid data throughout imports', () => {
  assert.throws(() => materialGraph(surface.material(scalar.parameter(.3))), /expects color, received scalar/);
  assert.throws(() => materialGraph(surface.material(color.mix(color.linear([1, 0, 0]), surface.paint(), .5))), /expects color, received surface/);
  assert.throws(() => materialGraph(surface.channels(surface.material(color.linear([1, 1, 1])), {roughness: color.linear([0, 0, 0])})), /expects scalar, received color/);
  assert.throws(() => materialGraph(surface.material(() => [1, 0, 0])), /not callbacks/);
  assert.throws(() => graphOf(color.mix(color.linear([0, 0, 0]), color.linear([1, 1, 1]), () => .5)), /not callbacks/);
  for (const value of [[-1e21, 0, 0], [0, 0, 1e21], [0, 0], [0, , 1], [0, 0, NaN], [0, 0, Infinity]]) {
    assert.throws(() => graphOf(color.linear(value)), /color.value/);
  }
  const base = materialGraph(surface.material(color.linear([.1, .2, .3])));
  for (const seed of [-1, .5, 4294967296, NaN, Infinity, '4', null]) {
    assert.throws(() => materialGraph({...base, nodes: [...base.nodes, {id: 'unused', kind: 'noise', seed}]}), /noise.seed/);
  }
  assert.throws(() => materialGraph({...base, nodes: [...base.nodes, {id: 'unused', kind: 'color', value: [1e21, 0, 0]}]}), /color.value/);
  const defaultSeed = materialGraph(surface.channels(surface.material(color.linear([1, 1, 1])), {roughness: scalar.noise()}));
  assert.equal(defaultSeed.nodes.find(value => value.kind === 'noise').seed, 0);
  assert.throws(() => scalar.noise({frequency: 2}), /Unknown noise expression property/);
  assert.throws(() => materialGraph(surface.channels(surface.material(color.linear([1, 1, 1])), {roughness: scalar.noise({domain: scalar.constant(1)})})), /expects domain, received scalar/);
});

test('color and seed patches are atomic and preserve no-op and untouched identities', () => {
  const graph = materialGraph(composition().expression), before = serializeGraph(graph);
  assert.equal(patchGraph(graph, {grain: {seed: 41}, ink: {value: [...node(graph, 'ink').value]}}), graph);
  assert.throws(() => patchGraph(graph, {grain: {seed: 42}, ink: {value: [1e21, 0, 0]}}), /color.value/);
  assert.equal(serializeGraph(graph), before);
  const edited = patchGraph(graph, {grain: {seed: 0xffffffff}, ink: {value: [.2, .3, .4]}});
  assert.equal(node(edited, 'grain').seed, 0xffffffff);
  assert.deepEqual(node(edited, 'ink').value, [.2, .3, .4]);
  for (const value of graph.nodes) {
    if (value.id !== 'grain' && value.id !== 'ink') assert.equal(node(edited, value.id), value);
  }
  assert.equal(node(graph, 'grain').seed, 41);
  assert.throws(() => patchGraph(graph, {grain: {domain: 'frame'}}), /Unknown grain value patch property/);
  const material = graph.nodes.find(value => value.kind === 'material');
  assert.throws(() => patchGraph(graph, {[material.id]: {color: 'ink'}}), /structural/);
});

test('domain substitution reaches procedural color and finish while preserving coordinate-free sharing', () => {
  const source = composition(), frame = domain.transform(identity);
  const bound = inDomain(source.expression, frame);
  assert.equal(inDomain(source.ink, frame), source.ink);
  assert.equal(inDomain(source.glaze), source.glaze);
  assert.equal(bound.input.color.a, source.ink);
  assert.equal(bound.input.color.mask, bound.values.roughness);
  assert.equal(bound.values.roughness.domain, frame);
  const graph = materialGraph(bound);
  assert.equal(graph.nodes.filter(value => value.kind === 'noise').length, 1);
  assert.equal(graph.nodes.filter(value => value.kind === 'transform').length, 1);
});

test('folds receive interpreted colors and visit shared procedural inputs once', () => {
  const graph = materialGraph(composition().expression), visits = new Map();
  const observe = (value, result) => { visits.set(value.id, (visits.get(value.id) ?? 0) + 1); return result; };
  const result = foldGraph(graph, {
    noise: value => observe(value, .25),
    color: value => observe(value, value.value),
    colorMix: value => observe(value, value.a.map((component, index) => component * (1 - value.mask) + value.b[index] * value.mask)),
    material: value => observe(value, {color: value.color}),
    channels: value => observe(value, {...value.input, ...value.values}),
  });
  assert.equal(result.roughness, .25);
  assert.equal(result.color.length, 3);
  assert.equal(visits.size, graph.nodes.length);
  assert([...visits.values()].every(count => count === 1));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  named, scalar, color, domain, facets, surface, inDomain, materialGraph,
  patchGraph, compileGraph, serializeGraph, parseGraph, evaluateScalar,
} from '../src/core.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const nodesById = graph => new Map(graph.nodes.map(node => [node.id, node]));

function composition(name = (_id, expression) => expression, frame) {
  const field = name('field', facets({domain: frame}));
  const bodyInk = name('bodyInk', color.srgb('#456b83'));
  const body = name('body', surface.paint(field, 'carapace', {base: bodyInk}));
  const belly = name('belly', surface.paint(field, 'horn'));
  const strength = name('strength', scalar.parameter(.7));
  const transition = name('transition', scalar.ramp(name('height', scalar.axis('y', frame)), -.4, .6));
  return name('skin', surface.mix(body, belly, scalar.multiply(strength, transition)));
}

test('named authoring uses canonical graph IDs for every independently editable value', () => {
  const expression = composition(named), graph = materialGraph(expression), plan = compileGraph(graph);
  assert.equal(graph.output, 'skin');
  assert.equal(graph.version, 2);
  assert.deepEqual(Object.keys(graph), ['version', 'nodes', 'output']);
  assert.equal(materialGraph(expression), graph);
  const changed = patchGraph(graph, {
    strength: {value: .4}, field: {scale: .32}, transition: {high: 1.2},
    body: {style: {roughness: .61}}, bodyInk: {value: color.srgb('#123456').value},
  });
  const nodes = nodesById(changed);
  assert.equal(evaluateScalar(changed, 'strength').value, .4);
  assert.equal(nodes.get('field').scale, .32);
  assert.equal(nodes.get('transition').high, 1.2);
  assert.equal(nodes.get('body').style.roughness, .61);
  assert.equal(nodes.get('body').palette.base, 'bodyInk');
  assert.deepEqual(nodes.get('bodyInk').value, color.srgb('#123456').value);
  assert.equal(nodes.get('belly'), nodesById(graph).get('belly'));
  assert.equal(compileGraph(changed).structure, plan.structure);
  assert.equal(compileGraph(changed).programKey, plan.programKey);
  assert.equal(serializeGraph(parseGraph(serializeGraph(changed))), serializeGraph(changed));
  assert.equal(evaluateScalar(graph, 'strength').value, .7);
});

test('author names do not change canonical shader work or scalar semantics', () => {
  const unnamed = compileGraph(composition()), authored = compileGraph(composition(named));
  assert.equal(authored.programKey, unnamed.programKey);
  assert.deepEqual(authored.nodes, unnamed.nodes);
  assert.deepEqual(authored.cost, unnamed.cost);
  assert.equal(authored.cost.paintSamples, 1);
  for (const position of [[0, -.2, 0], [.1, .3, 1], [0, 2, 0]]) {
    const unnamedRamp = unnamed.graph.nodes.filter(node => node.kind === 'ramp')[0];
    assert.deepEqual(evaluateScalar(authored.graph, 'transition', {position}),
      evaluateScalar(unnamed.graph, unnamedRamp.id, {position}));
  }
});

test('unnamed expressions assign deterministic postorder IDs to canonical palette nodes', () => {
  const field = facets();
  const expression = surface.mix(surface.paint(field, 'carapace'), surface.paint(field, 'horn'), scalar.parameter(.4));
  const expected = {
    version: 2, nodes: [
      {id: 'n0', kind: 'facets'},
      {id: 'n1', kind: 'color', value: color.srgb('#456b83').value},
      {id: 'n2', kind: 'color', value: color.srgb('#1d2b45').value},
      {id: 'n3', kind: 'color', value: color.srgb('#d4d9c2').value},
      {id: 'n4', kind: 'paint', field: 'n0', palette: {base: 'n1', shadow: 'n2', light: 'n3'}, style: 'carapace'},
      {id: 'n5', kind: 'color', value: color.srgb('#c1b397').value},
      {id: 'n6', kind: 'color', value: color.srgb('#74614f').value},
      {id: 'n7', kind: 'color', value: color.srgb('#ece3c7').value},
      {id: 'n8', kind: 'paint', field: 'n0', palette: {base: 'n5', shadow: 'n6', light: 'n7'}, style: 'horn'},
      {id: 'n9', kind: 'parameter', value: .4},
      {id: 'n10', kind: 'mix', a: 'n4', b: 'n8', mask: 'n9'},
    ], output: 'n10',
  };
  assert.equal(serializeGraph(expression), serializeGraph(expected));
});

test('generated IDs reserve explicit IDs encountered later in the composition', () => {
  const field = facets(), amount = named('n0', scalar.parameter(.4));
  const graph = materialGraph(named('result', surface.mix(surface.paint(field), surface.paint(field, 'horn'), amount)));
  assert.deepEqual(graph.nodes.map(node => node.id), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n0', 'result']);
  assert.equal(nodesById(graph).get('result').mask, 'n0');
  assert.equal(evaluateScalar(graph, 'n0').value, .4);
});

test('sharing a named expression is explicit; independent duplicate IDs are rejected', () => {
  const value = named('amount', scalar.parameter(.4));
  const shared = materialGraph(surface.channels(surface.paint(), {roughness: scalar.add(value, value)}));
  assert.equal(shared.nodes.filter(node => node.id === 'amount').length, 1);
  const other = named('amount', scalar.parameter(.4));
  assert.throws(() => materialGraph(surface.channels(surface.paint(), {roughness: scalar.add(value, other)})), /Duplicate node ID: amount/);
  assert.throws(() => materialGraph(named('amount', surface.channels(surface.paint(), {roughness: value}))), /Duplicate node ID: amount/);
});

test('naming and renaming are pure, with an owned same-name identity', () => {
  const raw = {kind: 'facets', scale: .2, stretch: [1, 2, 3]};
  const field = named('field', raw), renamed = named('detail', field);
  assert.equal(named('field', field), field);
  assert.notEqual(renamed, field);
  assert.equal(renamed.id, 'detail'); assert.equal(field.id, 'field');
  raw.stretch[1] = 9;
  assert.equal(raw.id, undefined);
  assert.equal(Object.isFrozen(raw), false); assert.equal(Object.isFrozen(raw.stretch), false);
  assert.equal(field.stretch[1], 2); assert.equal(renamed.stretch[1], 2);
  const input = {kind: 'parameter', id: 'raw', value: .3};
  assert.notEqual(named('raw', input), input);
  assert.equal(Object.isFrozen(input), false);
  for (const id of ['', 'two names', '1name', 'x'.repeat(65), null]) {
    assert.throws(() => named(id, scalar.parameter(.4)), /node ID/);
  }
  assert.throws(() => named('wrong', () => scalar.parameter(.4)), /graph expression/);
});

test('domain binding preserves author names, while independent named instances need distinct IDs', () => {
  const matrix = [...identity]; matrix[5] = 2; matrix[13] = -.1;
  const frame = named('frame', domain.transform(matrix)), original = composition(named);
  const moved = materialGraph(inDomain(original, frame));
  const explicit = materialGraph(composition(named, frame));
  assert.equal(serializeGraph(moved), serializeGraph(explicit));
  assert.equal(evaluateScalar(moved, 'height', {position: [0, .3, 0]}).value, .5);
  assert.equal(evaluateScalar(moved, 'strength').value, .7);
  assert.throws(() => materialGraph(surface.mix(original, inDomain(original, frame), .5)), /Duplicate node ID/);
  const second = composition((id, expression) => named(`other_${id}`, expression), frame);
  assert.doesNotThrow(() => materialGraph(surface.mix(original, second, .5)));
});

test('naming does not turn a literal into an editable parameter', () => {
  const literal = named('fixed', scalar.constant(0));
  const parameter = named('strength', scalar.parameter(0));
  const graph = materialGraph(surface.channels(surface.paint(), {roughness: literal, metalness: parameter}));
  assert.throws(() => patchGraph(graph, {fixed: {value: .5}}), /structural/);
  const plan = compileGraph(graph), edited = compileGraph(patchGraph(graph, {strength: {value: 1}}));
  assert.equal(edited.structure, plan.structure);
  assert.equal(edited.programKey, plan.programKey);
  assert.equal(evaluateScalar(edited.graph, 'strength').value, 1);
});

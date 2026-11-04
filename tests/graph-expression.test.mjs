import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scalar, color, domain, facets, surface, named, instantiate, inDomain,
  expressionGraph, graphExpression, materialGraph, parseExpressionGraph,
  serializeGraph, patchGraph, createFieldSampler, evaluateScalar, compileGraph,
} from '../src/core.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('every graph sort reifies to an owned expression with its exact reachable document', () => {
  for (const authored of [
    named('frame', domain.transform(identity)),
    named('height', scalar.multiply(scalar.noise({seed: 7}), .03)),
    named('pigment', color.mix(color.srgb('#123456'), color.srgb('#abcdef'), .3)),
    named('field', facets()),
    named('skin', surface.bump(surface.paint('carapace'), scalar.noise({seed: 7}))),
  ]) {
    const graph = parseExpressionGraph(serializeGraph(expressionGraph(authored)));
    const recovered = graphExpression(graph);
    assert.equal(recovered.kind, authored.kind);
    assert.equal(recovered.id, graph.output);
    assert.equal(Object.isFrozen(recovered), true);
    assert.equal(graphExpression(graph), recovered);
    assert.equal(graphExpression(graph, graph.output), recovered);
    assert.equal(serializeGraph(expressionGraph(recovered)), serializeGraph(graph));
    assert.equal(instantiate(recovered, {prefix: 'ignored', shared: [recovered]}), recovered);
  }
});

test('reification preserves sharing through single, record and list ports across extracted roots', () => {
  const ink = named('ink', color.srgb('#203040'));
  const grain = named('grain', scalar.noise({seed: 17}));
  const palette = named('palette', color.ramp(grain, [[0, ink], [1, ink]]));
  const authored = surface.channels(surface.bump(
    surface.paint('carapace', {palette: {base: palette, shadow: ink}}), grain,
  ), {roughness: grain});
  for (const childFirst of [false, true]) {
    const graph = parseExpressionGraph(serializeGraph(authored));
    const first = childFirst ? graphExpression(graph, 'ink') : undefined;
    const recovered = graphExpression(graph), paint = recovered.input.input;
    const recoveredInk = graphExpression(graph, 'ink'), recoveredGrain = graphExpression(graph, 'grain');
    assert.equal(paint.palette.shadow, recoveredInk);
    assert.equal(paint.palette.base.colors[0], recoveredInk);
    assert.equal(paint.palette.base.colors[1], recoveredInk);
    assert.equal(paint.palette.base.input, recoveredGrain);
    assert.equal(recovered.input.height, recoveredGrain);
    assert.equal(recovered.values.roughness, recoveredGrain);
    if (childFirst) assert.equal(first, recoveredInk);
    assert.equal(Object.isFrozen(paint.palette), true);
    assert.equal(Object.isFrozen(paint.palette.base.colors), true);
  }
});

test('overlapping extracted roots share their complete prefixes in every request order', () => {
  let authored = named('step0', scalar.parameter(.2));
  const ids = ['step0'];
  for (let i = 1; i <= 40; i++) {
    ids.push(`step${i}`);
    authored = named(ids.at(-1), scalar.add(authored, scalar.parameter(i / 100)));
  }
  const source = serializeGraph(authored);
  for (const order of [ids, [...ids].reverse(), [...ids.filter((_, i) => i % 2), ...ids.filter((_, i) => !(i % 2))]]) {
    const graph = parseExpressionGraph(source);
    const roots = new Map(order.map(id => [id, graphExpression(graph, id)]));
    for (let i = 1; i <= 40; i++) assert.equal(roots.get(ids[i]).a, roots.get(ids[i - 1]));
    const sum = expressionGraph(scalar.add(roots.get('step40'), roots.get('step20')));
    assert.equal(sum.nodes.length, 82);
    assert.equal(createFieldSampler(sum)().value,
      evaluateScalar(graph, 'step40').value + evaluateScalar(graph, 'step20').value);
    assert.equal(serializeGraph(roots.get('step40')), source);
    const revised = patchGraph(graph, {step0: {value: .8}});
    const updated = graphExpression(revised);
    assert.notEqual(updated, roots.get('step40'));
    assert.equal(createFieldSampler(updated)().value, evaluateScalar(revised, 'step40').value);
    assert.equal(graphExpression(graph, 'step0'), roots.get('step0'));
    assert.equal(roots.get('step0').value, .2);
  }
});

test('reification selects reachable definitions but still validates the complete import', () => {
  const document = {version: 1, output: 'sum', nodes: [
    {id: 'unused', kind: 'parameter', value: .9},
    {id: 'gain', kind: 'parameter', value: .3},
    {id: 'sum', kind: 'add', a: 'gain', b: 'gain'},
  ]};
  const graph = expressionGraph(document), recovered = graphExpression(graph);
  assert.deepEqual(expressionGraph(recovered).nodes.map(node => node.id), ['gain', 'sum']);
  assert.deepEqual(expressionGraph(graphExpression(graph, 'unused')).nodes,
    [{id: 'unused', kind: 'parameter', value: .9}]);
  assert.equal(graph.nodes.length, 3);
  assert.equal(Object.isFrozen(document), false);
  assert.throws(() => graphExpression(graph, 'missing'), /Unknown graph root/);
  assert.throws(() => graphExpression({...document, nodes: [...document.nodes,
    {id: 'bad', kind: 'complement', input: 'bad'}]}), /Cyclic/);
});

test('reification caches only immutable revisions and isolates patched and raw input values', () => {
  const graph = expressionGraph(named('sum', scalar.add(named('gain', scalar.parameter(.3)), .2)));
  const first = graphExpression(graph), sample = createFieldSampler(first);
  const revised = patchGraph(graph, {gain: {value: .7}}), second = graphExpression(revised);
  assert.notEqual(second, first);
  assert.notEqual(second.a, first.a);
  assert.equal(graphExpression(patchGraph(graph, {gain: {value: .3}})), first);
  assert.equal(graphExpression(revised, 'gain'), second.a);
  assert.equal(sample().value, .5);
  assert.equal(createFieldSampler(second)().value, .8999999999999999);

  const raw = JSON.parse(serializeGraph(graph));
  const before = graphExpression(raw);
  raw.nodes.find(node => node.id === 'gain').value = .8;
  const after = graphExpression(raw);
  assert.notEqual(before, after);
  assert.equal(createFieldSampler(before)().value, .5);
  assert.equal(createFieldSampler(after)().value, 1);
});

test('persisted scalar, color and domain roots compose into independently scoped materials', () => {
  const restore = input => parseExpressionGraph(serializeGraph(expressionGraph(input)));
  const heightGraph = restore(named('height', scalar.multiply(
    named('depth', scalar.parameter(.03)), named('grain', scalar.noise({seed: 7})),
  )));
  const height = graphExpression(heightGraph), depth = graphExpression(heightGraph, 'depth');
  const pigment = graphExpression(restore(named('pigment', color.srgb('#203040'))));
  const matrix = [...identity]; matrix[0] = 2;
  const frame = graphExpression(restore(named('frame', domain.transform(matrix))));
  const template = surface.bump(surface.material(pigment), inDomain(height, frame));
  const left = instantiate(template, {prefix: 'left', shared: [depth, pigment]});
  const right = instantiate(template, {prefix: 'right', shared: [depth, pigment]});
  const graph = materialGraph(surface.mix(left, right, .5));
  assert.equal(graph.nodes.filter(node => node.id === 'depth').length, 1);
  assert.equal(graph.nodes.filter(node => node.id === 'pigment').length, 1);
  assert.deepEqual(graph.nodes.filter(node => node.kind === 'noise').map(node => node.id),
    ['left_grain', 'right_grain']);
  assert.equal(compileGraph(graph).cost.proceduralSamples, 2);
  const context = {position: [.2, .3, .4], dx: [.01, 0, 0]};
  const oldRight = evaluateScalar(graph, 'right_height', context);
  const revised = patchGraph(graph, {left_grain: {seed: 41}});
  assert.deepEqual(evaluateScalar(revised, 'right_height', context), oldRight);
  assert.notDeepEqual(evaluateScalar(revised, 'left_height', context), oldRight);
});

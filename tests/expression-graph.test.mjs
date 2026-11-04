import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expressionGraph, materialGraph, parseExpressionGraph, parseGraph, serializeGraph,
  patchGraph, foldGraph, createFieldSampler, evaluateScalar, evaluateColor, compileGraph,
  scalar, color, domain, facets, surface, named, instantiate, inDomain, GRAPH_LIMITS,
} from '../src/core.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const byId = graph => new Map(graph.nodes.map(node => [node.id, node]));

test('all five expression sorts are graph roots, while material boundaries remain strict', () => {
  const expressions = [
    named('frame', domain.transform(identity)),
    named('grain', scalar.noise({seed: 7})),
    named('ink', color.srgb('#234567')),
    named('field', facets()),
    named('skin', surface.paint('carapace')),
  ];
  for (const expression of expressions) {
    const graph = expressionGraph(expression), text = serializeGraph(graph);
    assert.equal(expressionGraph(expression), graph);
    assert.equal(expressionGraph(graph), graph);
    assert.equal(graph.output, expression.id);
    assert.deepEqual(Object.keys(graph), ['version', 'nodes', 'output']);
    assert.equal(serializeGraph(parseExpressionGraph(text)), text);
    if (expression.kind === 'paint') {
      assert.equal(materialGraph(graph), graph);
      assert.deepEqual(parseGraph(text), graph);
    } else {
      assert.throws(() => materialGraph(graph), /surface node/);
      assert.throws(() => compileGraph(graph), /surface node/);
      assert.throws(() => parseGraph(text), /surface node/);
    }
  }
  assert.equal(expressionGraph('carapace').output, materialGraph('carapace').output);
  assert.throws(() => createFieldSampler(facets()), /received facets/);
  assert.throws(() => createFieldSampler(surface.paint()), /received surface/);
});

test('generic documents keep the same complete validation and JSON boundary', () => {
  const raw = {version: 1, nodes: [{id: 'grain', kind: 'noise'}], output: 'grain'};
  const graph = expressionGraph(raw);
  assert.equal(graph.nodes[0].seed, 0);
  assert.notEqual(graph, raw);
  assert.equal(Object.isFrozen(raw), false);
  raw.nodes[0].seed = 4;
  assert.equal(graph.nodes[0].seed, 0);
  assert.throws(() => expressionGraph({...raw, output: 'missing'}), /Unknown graph output/);
  assert.throws(() => expressionGraph({...raw, nodes: [...raw.nodes,
    {id: 'unused', kind: 'complement', input: 'unused'}]}), /Cyclic/);
  assert.throws(() => expressionGraph({...raw, nodes: [...raw.nodes,
    {id: 'unused', kind: 'noise', seed: -1}]}), /noise.seed/);
  assert.throws(() => expressionGraph(color.mix(color.srgb('#123456'), scalar.parameter(.2), .5)), /expects color/);
  assert.throws(() => parseExpressionGraph(' '.repeat(GRAPH_LIMITS.jsonBytes + 1)), /size/);
});

test('generic patches and folds retain a field root, sharing and atomic updates', () => {
  const amount = named('amount', scalar.parameter(.25));
  const graph = expressionGraph(named('sum', scalar.add(amount, amount)));
  const counts = new Map();
  const algebra = {
    parameter: node => {counts.set(node.id, (counts.get(node.id) ?? 0) + 1); return node.value;},
    add: node => node.a + node.b,
  };
  assert.equal(foldGraph(graph, algebra), .5);
  assert.equal(counts.get('amount'), 1);
  assert.equal(graph.nodes.length, 2);
  const edited = patchGraph(graph, {amount: {value: .4}});
  assert.equal(edited.output, 'sum');
  assert.equal(edited.nodes[1], graph.nodes[1]);
  assert.equal(foldGraph(edited, algebra), .8);
  assert.equal(patchGraph(edited, {amount: {value: .4}}), edited);
  assert.throws(() => patchGraph(edited, {amount: {value: .7}, sum: {a: 'amount'}}), /structural/);
  assert.equal(foldGraph(edited, algebra), .8);
  assert.equal(serializeGraph(parseExpressionGraph(serializeGraph(edited))), serializeGraph(edited));
});

test('recomposed documents borrow validated nodes, including value patches, without trusting frozen authors', () => {
  const input = materialGraph(surface.paint('carapace'));
  const paint = input.nodes.find(node => node.kind === 'paint');
  const changed = patchGraph(input, {[paint.id]: {style: {roughness: .2}}});
  for (const graph of [input, changed]) {
    const restored = materialGraph({...graph, nodes: [...graph.nodes]});
    assert.notEqual(restored, graph);
    assert(restored.nodes.every((node, index) => node === graph.nodes[index]));
    assert.equal(serializeGraph(restored), serializeGraph(graph));
  }
  const colorNode = input.nodes.find(node => node.kind === 'color');
  const authored = named(colorNode.id, color.linear([.1, .2, .3]));
  const copied = expressionGraph({version: 2, nodes: [authored], output: authored.id});
  assert.notEqual(copied.nodes[0], authored, 'constructor ownership alone does not prove a normalized node');
  const invalid = Object.freeze({...colorNode, value: Object.freeze([NaN, .2, .3])});
  assert.throws(() => expressionGraph({version: 2, nodes: [invalid], output: invalid.id}), /color.value/);
});

test('borrowing normalized nodes still validates graph references, sorts, cycles and depth', () => {
  const a = expressionGraph({version: 2, output: 'a', nodes: [
    {id: 'b', kind: 'parameter', value: .3}, {id: 'a', kind: 'complement', input: 'b'},
  ]});
  const b = expressionGraph({version: 2, output: 'b', nodes: [
    {id: 'a', kind: 'parameter', value: .3}, {id: 'b', kind: 'complement', input: 'a'},
  ]});
  const parent = a.nodes.find(node => node.id === 'a');
  const wrongSort = expressionGraph(named('b', color.linear([.1, .2, .3]))).nodes[0];
  assert.throws(() => expressionGraph({...a, nodes: [parent]}), /Dangling reference/);
  assert.throws(() => expressionGraph({...a, nodes: [parent, wrongSort]}), /expects scalar, received color/);
  assert.throws(() => expressionGraph({...a, nodes: [parent, b.nodes.find(node => node.id === 'b')]}), /Cyclic/);
  const nodes = [{id: 'depth0', kind: 'parameter', value: .3}];
  for (let i = 1; i < GRAPH_LIMITS.depth; i++) nodes.push({id: `depth${i}`, kind: 'complement', input: `depth${i - 1}`});
  const deep = expressionGraph({version: 2, nodes, output: nodes.at(-1).id});
  assert.throws(() => expressionGraph({...deep, output: 'extra', nodes: [...deep.nodes,
    {id: 'extra', kind: 'complement', input: deep.output}]}), /maximum depth/);
});

test('prepared scalar, color and domain roots sample directly and retain their differentials', () => {
  const gain = named('gain', scalar.parameter(3));
  const value = named('value', scalar.multiply(scalar.axis('x'), gain));
  const graph = expressionGraph(value), sample = createFieldSampler(value);
  const context = {position: [2, 0, 0], dx: [.2, 0, 0], dy: [0, .3, 0]};
  assert.equal(createFieldSampler(graph), sample);
  assert.deepEqual(sample(context), {value: 6, dx: .6000000000000001, dy: 0});
  assert.deepEqual(sample(context), evaluateScalar(graph, 'value', context));

  const pigment = named('pigment', color.mix(color.linear([0, 0, 0]), color.linear([1, 1, 1]), scalar.axis('x')));
  const colorGraph = expressionGraph(pigment), colorSample = createFieldSampler(colorGraph);
  const at = {position: [.4, 0, 0], dx: [.1, 0, 0], dy: [0, .2, 0]};
  assert.deepEqual(colorSample(at), {value: [.4, .4, .4], dx: [.1, .1, .1], dy: [0, 0, 0]});
  assert.deepEqual(colorSample(at), evaluateColor(colorGraph, 'pigment', at));

  const matrix = [...identity]; matrix[0] = 2; matrix[12] = -1;
  const frameSample = createFieldSampler(domain.transform(matrix))(context);
  assert.deepEqual(frameSample.position, [3, 0, 0]);
  assert.deepEqual(frameSample.dx, [.4, 0, 0]);
  assert.deepEqual(frameSample.dy, [0, .3, 0]);
});

test('prepared samplers own one immutable graph revision and never retain sample contexts', () => {
  const graph = expressionGraph(named('height', scalar.multiply(scalar.axis('x'), named('gain', scalar.parameter(2)))));
  const first = createFieldSampler(graph), next = createFieldSampler(patchGraph(graph, {gain: {value: 3}}));
  const context = {position: [1, 0, 0], dx: [1, 0, 0]};
  const saved = first(context);
  context.position[0] = 4;
  assert.equal(first(context).value, 8);
  assert.equal(next(context).value, 12);
  assert.deepEqual(saved, {value: 2, dx: 2, dy: 0});
  assert(Object.isFrozen(saved));
  context.position[0] = NaN;
  assert.throws(() => first(context), /sample position/);
  context.position[0] = 1;
  assert.deepEqual(first(context), saved);
});

test('scoped instances have independent local values and explicit shared inputs', () => {
  const common = named('common', scalar.parameter(.2));
  const local = named('gain', scalar.parameter(.3));
  const expression = named('field', scalar.add(common, local));
  const left = instantiate(expression, {prefix: 'left', shared: [common]});
  const right = instantiate(expression, {prefix: 'right', shared: [common]});
  assert.equal(left.a, common);
  assert.equal(right.a, common);
  assert.notEqual(left.b, local);
  assert.notEqual(left.b, right.b);
  const graph = expressionGraph(scalar.add(left, right));
  assert.deepEqual(graph.nodes.filter(node => node.kind === 'parameter').map(node => node.id),
    ['common', 'left_gain', 'right_gain']);
  assert.equal(createFieldSampler(graph)().value, 1);
  const edited = patchGraph(graph, {left_gain: {value: .5}});
  assert.equal(evaluateScalar(edited, 'left_field').value, .7);
  assert.equal(evaluateScalar(edited, 'right_field').value, .5);
  const commonEdit = patchGraph(edited, {common: {value: .4}});
  assert.equal(evaluateScalar(commonEdit, 'left_field').value, .9);
  assert.equal(evaluateScalar(commonEdit, 'right_field').value, .7);
  assert.equal(expression.id, 'field');
  assert.equal(local.value, .3);
});

test('unnamed instance values are independent and local DAG sharing is retained', () => {
  const gain = scalar.parameter(.2), expression = scalar.add(gain, gain);
  const a = instantiate(expression, {prefix: 'a'}), b = instantiate(expression, {prefix: 'b'});
  assert.equal(a.a, a.b);
  assert.equal(b.a, b.b);
  assert.notEqual(a.a, gain);
  assert.notEqual(a.a, b.a);
  const graph = expressionGraph(scalar.add(a, b));
  assert.equal(graph.nodes.filter(node => node.kind === 'parameter').length, 2);
});

test('an explicitly shared subgraph protects its descendants used elsewhere', () => {
  const leaf = named('global', scalar.parameter(.4));
  const shared = named('shared', scalar.add(leaf, .1));
  const copied = instantiate(scalar.add(shared, leaf), {prefix: 'local', shared: [shared]});
  assert.equal(copied.a, shared);
  assert.equal(copied.b, leaf);
  assert.equal(instantiate(shared, {prefix: 'ignored', shared: [shared]}), shared);
  assert.equal(expressionGraph(copied).nodes.filter(node => node.id === 'global').length, 1);
});

test('instancing snapshots raw local inputs once without mutating or freezing caller data', () => {
  const shared = {kind: 'parameter', id: 'global', value: .2};
  const local = {kind: 'parameter', id: 'gain', value: .3};
  const raw = {kind: 'add', a: shared, b: {kind: 'add', a: shared, b: local}};
  const copied = instantiate(raw, {prefix: 'local'});
  assert.equal(copied.a, copied.b.a);
  assert.notEqual(copied.a, shared);
  shared.value = .9; local.value = .8;
  assert.equal(createFieldSampler(copied)().value, .7);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.isFrozen(shared), false);
  assert.equal(Object.isFrozen(local), false);
});

test('shared roots require immutable constructor ownership before template composition', () => {
  const raw = {kind: 'parameter', id: 'shared', value: .2};
  for (const prefix of ['left', 'right']) {
    assert.throws(() => instantiate({kind: 'add', a: raw, b: raw}, {prefix, shared: [raw]}),
      /shared inputs must be Moonweave-owned.*named/);
  }
  assert.equal(Object.isFrozen(raw), false);
  // Even deeply frozen caller data must cross the normal ownership boundary.
  assert.throws(() => instantiate(raw, {prefix: 'left', shared: [Object.freeze(raw)]}),
    /shared inputs must be Moonweave-owned/);
  const shared = named('shared', raw);
  const template = scalar.add(shared, named('gain', scalar.parameter(.3)));
  const left = instantiate(template, {prefix: 'left', shared: [shared]});
  const right = instantiate(template, {prefix: 'right', shared: [shared]});
  assert.equal(left.a, shared);
  assert.equal(right.a, shared);
  assert.equal(createFieldSampler(scalar.add(left, right))().value, 1);
});

test('borrowing an owned root preserves its snapshotted descendants and cross references', () => {
  const rawLeaf = {kind: 'parameter', id: 'global', value: .2};
  const shared = named('shared', {kind: 'add', a: rawLeaf, b: rawLeaf});
  assert.notEqual(shared.a, rawLeaf);
  const template = {kind: 'add', a: shared, b: shared.a};
  const left = instantiate(template, {prefix: 'left', shared: [shared]});
  const right = instantiate(template, {prefix: 'right', shared: [shared]});
  assert.equal(left.a, shared);
  assert.equal(right.a, shared);
  assert.equal(left.b, shared.a);
  assert.equal(right.b, shared.a);
  assert.equal(shared.a, shared.b);
  rawLeaf.value = .9;
  assert.equal(createFieldSampler(left)().value, .6000000000000001);
  assert.equal(expressionGraph(scalar.add(left, right)).nodes.filter(node => node.id === 'global').length, 1);
});

test('instancing traverses palette records and stop lists and composes with domain binding', () => {
  const ink = named('ink', color.srgb('#203040'));
  const palette = named('palette', color.ramp(scalar.axis('x'), [
    [0, ink], [1, named('pearl', color.srgb('#d0e0e0'))],
  ]));
  const source = named('skin', surface.paint('carapace', {palette: {base: palette, shadow: ink}}));
  const copy = instantiate(source, {prefix: 'wing', shared: [ink]});
  assert.equal(copy.palette.shadow, ink);
  assert.equal(copy.palette.base.colors[0], ink);
  assert.equal(copy.palette.base.colors[1].id, 'wing_pearl');
  const matrix = [...identity]; matrix[0] = 2;
  const frame = domain.transform(matrix), graph = materialGraph(inDomain(copy, frame));
  assert.equal(graph.output, 'wing_skin');
  const nodes = byId(graph);
  assert.equal(nodes.get('wing_palette').colors[0], 'ink');
  const explicit = materialGraph(instantiate(inDomain(source, frame), {prefix: 'wing', shared: [ink]}));
  assert.equal(serializeGraph(graph), serializeGraph(explicit));
});

test('invalid scopes, full IDs, duplicate names and cycles are rejected without truncation', () => {
  const value = named('value', scalar.parameter(.2));
  for (const prefix of ['', '1bad', 'two words', 'a'.repeat(65)]) {
    assert.throws(() => instantiate(value, {prefix}), /node ID/);
  }
  assert.throws(() => instantiate(named('a'.repeat(63), scalar.parameter(1)), {prefix: 'b'}), /node ID/);
  assert.throws(() => instantiate({kind: 'parameter', id: '1bad', value: .2}, {prefix: 'valid'}), /node ID/);
  assert.throws(() => instantiate(value, {prefix: 'a', extra: true}), /Unknown instance/);
  assert.throws(() => instantiate(value, {prefix: 'a', shared: 'value'}), /array/);
  assert.throws(() => instantiate(value, {prefix: 'a', shared: [() => value]}), /graph expression/);
  const ambiguous = scalar.add(value, named('value', scalar.parameter(.3)));
  assert.throws(() => expressionGraph(instantiate(ambiguous, {prefix: 'a'})), /Duplicate node ID/);
  const cycle = {kind: 'complement'}; cycle.input = cycle;
  assert.throws(() => instantiate(cycle, {prefix: 'a'}), /Cyclic/);
});

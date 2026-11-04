import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coverage, mask, createFieldSampler, expressionGraph, patchGraph,
  scalar, color, domain, named, serializeGraph,
} from '../src/core.mjs';

const parameter = () => ({id: 'amount', kind: 'parameter', value: .4});
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('coverage helpers preserve a repeated raw named operand as one editable value', () => {
  for (const operation of ['intersect', 'union', 'subtract']) {
    const raw = parameter(), expression = coverage[operation](raw, raw);
    const graph = expressionGraph(expression);
    assert.equal(graph.nodes.filter(node => node.kind === 'parameter').length, 1);
    assert.equal(Object.isFrozen(raw), false);
    raw.value = .9;
    assert.equal(graph.nodes.find(node => node.id === 'amount').value, .4);
    const edited = patchGraph(graph, {amount: {value: .7}});
    assert.deepEqual(createFieldSampler(edited)(),
      createFieldSampler(coverage[operation](.7, .7))());
  }
});

test('coverage helpers preserve raw descendants shared by distinct operands', () => {
  for (const operation of ['union', 'subtract']) {
    const shared = parameter();
    const left = {kind: 'multiply', a: shared, b: {kind: 'constant', value: .5}};
    const right = {kind: 'complement', input: shared};
    const graph = expressionGraph(coverage[operation](left, right));
    assert.equal(graph.nodes.filter(node => node.id === 'amount').length, 1);
    const edited = patchGraph(graph, {amount: {value: .6}});
    assert.deepEqual(createFieldSampler(edited)(),
      createFieldSampler(coverage[operation](.6 * .5, 1 - .6))());
    assert.equal(Object.isFrozen(left), false);
    assert.equal(Object.isFrozen(right), false);
    assert.equal(Object.isFrozen(shared), false);
  }
});

test('coverage composition preserves existing owned and literal graph ordering', () => {
  for (const [a, b] of [[.2, .7], [named('a', scalar.parameter(.2)), named('b', scalar.parameter(.7))]]) {
    const left = typeof a === 'number' ? scalar.constant(a) : a;
    assert.equal(serializeGraph(coverage.union(a, b)),
      serializeGraph(scalar.add(left, scalar.multiply(scalar.complement(left), b))));
    assert.equal(serializeGraph(coverage.subtract(a, b)),
      serializeGraph(scalar.multiply(a, scalar.complement(b))));
  }
});

test('owned expression descendants remain shared when extracted, named or recomposed', () => {
  const expression = scalar.add(parameter(), 1), child = expression.a;
  const renamed = named('sum', expression);
  assert.equal(renamed.a, child);
  const combined = scalar.add(expression, child);
  assert.equal(combined.b, child);
  assert.equal(expressionGraph(combined).nodes.filter(node => node.id === 'amount').length, 1);

  for (const operation of ['union', 'subtract']) {
    const composed = coverage[operation](parameter(), .3);
    const reused = scalar.add(composed, composed.b);
    assert.equal(reused.b, composed.b);
    const graph = expressionGraph(reused);
    assert.equal(graph.nodes.filter(node => node.kind === 'complement').length, 1);
    assert.equal(graph.nodes.filter(node => node.kind === 'multiply').length, 1);
  }
});

test('snapshot ownership still isolates frozen caller inputs and rejects cyclic graphs', () => {
  const frozen = Object.freeze(parameter());
  const first = scalar.add(frozen, 1), second = scalar.add(frozen, 1);
  assert.notEqual(first.a, frozen);
  assert.notEqual(second.a, first.a);
  const cyclic = {kind: 'add', a: {kind: 'constant', value: 1}};
  cyclic.b = cyclic;
  const expression = scalar.complement(cyclic);
  assert.equal(Object.isFrozen(cyclic), false);
  assert.equal(Object.isFrozen(cyclic.a), false);
  assert.throws(() => expressionGraph(expression), /Cyclic graph expression/);
});

test('snapshots preserve sparse array lengths so construction cannot heal invalid author data', () => {
  const rgb = [.1, .2, .3]; rgb.length = 4;
  const matrix = identity(); matrix.length = 17;
  const colors = [color.linear([.1, .2, .3]), color.linear([.4, .5, .6])]; colors.length = 3;
  const positions = [0, 1]; positions.length = 3;
  const rawRamp = {kind: 'colorRamp', input: {kind: 'parameter', value: .4}, colors, positions};
  const cases = [
    [{kind: 'color', value: rgb}, color.linear(rgb), /color.value requires 3 components/],
    [{kind: 'transform', matrix}, scalar.axis('x', {kind: 'transform', matrix}), /domain matrix requires 16 components/],
    [rawRamp, color.mix(rawRamp, colors[0], .5), /graph expressions/],
  ];
  for (const [raw, composed, error] of cases) {
    assert.throws(() => expressionGraph(raw), error);
    assert.throws(() => expressionGraph(composed), error);
  }
  assert.equal(cases[0][1].value.length, 4);
  assert.equal(cases[1][1].domain.matrix.length, 17);
  assert.equal(cases[2][1].a.colors.length, 3);
  assert.equal(cases[2][1].a.positions.length, 3);
  for (const array of [rgb, matrix, colors, positions]) assert.equal(Object.isFrozen(array), false);
});

test('interval edges share one raw named field and follow its edits together', () => {
  const raw = parameter(), expression = mask.interval(raw, 0, 1, {feather: .2});
  const graph = expressionGraph(expression);
  assert.equal(graph.nodes.filter(node => node.kind === 'parameter').length, 1);
  assert.equal(Object.isFrozen(raw), false);
  raw.value = 9;
  for (const value of [.05, .4, .95]) {
    const edited = patchGraph(graph, {amount: {value}});
    assert.deepEqual(createFieldSampler(edited)(),
      createFieldSampler(mask.interval(value, 0, 1, {feather: .2}))());
  }
  const owned = named('amount', scalar.parameter(.4));
  assert.equal(serializeGraph(expression), serializeGraph(mask.interval(owned, 0, 1, {feather: .2})));
});

test('chisel axes share one raw named domain without freezing caller data', () => {
  const matrix = identity(), raw = {id: 'frame', kind: 'transform', matrix};
  const expression = mask.chisel({domain: raw}), graph = expressionGraph(expression);
  assert.equal(graph.nodes.filter(node => node.kind === 'transform').length, 1);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.isFrozen(matrix), false);
  matrix[12] = 9;
  const context = {position: [.9, .2, 0], dx: [1, 0, 0]};
  const owned = named('frame', domain.transform(identity()));
  assert.equal(serializeGraph(expression), serializeGraph(mask.chisel({domain: owned})));
  const shifted = identity(); shifted[12] = .1;
  const edited = patchGraph(graph, {frame: {matrix: shifted}});
  assert.deepEqual(createFieldSampler(edited)(context),
    createFieldSampler(mask.chisel({domain: domain.transform(shifted)}))(context));
});

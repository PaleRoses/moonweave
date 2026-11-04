import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scalar, color, domain, named, surface, expressionGraph, materialGraph, patchGraph, foldGraph,
} from '../src/core/graph.mts';
import {createFieldSampler, prepareFieldPoints, prepareFieldPoint} from '../src/core/evaluate.mts';
import {fieldAlgebra, sampleDomain, sampleField} from '../src/core/field-evaluate.mts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const context = {position: [.5, .25, -.1], dx: [1, 0, 0], dy: [0, 1, 0]};
const ordinary = (graph, id, sample = context) => sampleField(foldGraph(graph, fieldAlgebra, id), sample);

function overlappingRoots() {
  let expression = named('step0', scalar.noise({seed: 7}));
  const ids = ['step0'];
  for (let i = 1; i <= 40; i++) {
    ids.push(`step${i}`);
    expression = named(ids.at(-1), scalar.add(expression, scalar.parameter(i / 100)));
  }
  return {graph: expressionGraph(expression), ids};
}

test('81 source nodes prepare once across 41 overlapping roots, in either request order', () => {
  for (const reverse of [false, true]) {
    const {graph, ids} = overlappingRoots(), order = reverse ? [...ids].reverse() : ids;
    for (const [index, id] of order.entries()) {
      const prepared = prepareFieldPoint(graph, id);
      assert.equal(prepared.sourceNodes, reverse ? 81 : 1 + 2 * index);
      assert.equal(prepared.preparedNodes, prepared.sourceNodes);
    }
    const prepared = prepareFieldPoints(graph, ids);
    assert.equal(prepared.sourceNodes, 81);
    assert.equal(prepared.preparedNodes, 81);
    assert.equal(prepared.sharedNodes, 0);
    const state = {base: sampleDomain(context), values: new Map()};
    for (const root of prepared.roots) assert.deepEqual(root.point(state), ordinary(graph, root.id));
    assert.equal(state.values.size, 41, 'each varying prefix computes only once in a joint sample');
    assert.equal(prepareFieldPoint(graph, 'step0').point, prepared.roots[0].point);
    const select = Object.fromEntries(ids.map(id => [id, {id, sort: 'scalar'}]));
    const sample = createFieldSampler(graph, select)(context);
    for (const root of prepared.roots) assert.deepEqual(sample[root.id], root.point(state));
  }
});

test('scalar structural sharing extends across separately requested roots', () => {
  const gain = scalar.parameter(.7), branch = () => scalar.multiply(scalar.axis('x'), gain);
  const graph = materialGraph(surface.channels(surface.material(color.linear([.2, .3, .4])), {
    roughness: named('left', branch()), metalness: named('right', branch()),
  }));
  const left = prepareFieldPoint(graph, 'left');
  assert.equal(left.preparedNodes, 3);
  const right = prepareFieldPoint(graph, 'right');
  assert.equal(right.sourceNodes, 5);
  assert.equal(right.preparedNodes, 3);
  assert.equal(right.sharedNodes, 2);
  assert.equal(left.point, right.point);
  const sample = createFieldSampler(graph, {a: {id: 'left', sort: 'scalar'}, b: {id: 'right', sort: 'scalar'}})(context);
  assert.equal(sample.a, sample.b);
  assert.deepEqual(sample.a, ordinary(graph, 'left'));
});

test('mixed-sort outputs normalize context once, share results, and isolate every call and graph revision', () => {
  const frame = named('frame', domain.transform(identity));
  const gain = named('gain', scalar.parameter(.4));
  const mask = named('weight', scalar.multiply(scalar.ramp(scalar.axis('x', frame)), gain));
  const pigment = named('pigment', color.mix(color.linear([.1, .2, .3]), color.linear([.5, .6, .7]), mask));
  const graph = materialGraph(surface.channels(surface.material(pigment), {roughness: mask}));
  const select = {coverage: {id: 'weight', sort: 'scalar'}, ink: {id: 'pigment', sort: 'color'},
    space: {id: 'frame', sort: 'domain'}, again: {id: 'weight', sort: 'scalar'}};
  const sampler = createFieldSampler(graph, select);
  let reads = 0;
  const sample = sampler({...context, get position() { reads++; return context.position; }});
  assert.equal(reads, 1);
  assert.equal(sample.coverage, sample.again);
  for (const [name, root] of Object.entries(select)) assert.deepEqual(sample[name], ordinary(graph, root.id));
  assert(Object.isFrozen(sample));
  assert(Object.isFrozen(sample.ink.value));
  assert(Object.isFrozen(sample.space.position));
  assert.notEqual(sampler(context).coverage, sample.coverage, 'sample memo never persists between calls');
  select.coverage.id = 'missing';
  assert.deepEqual(sampler(context), sample, 'prepared selection does not retain mutable caller records');
  const changed = patchGraph(graph, {gain: {value: .8}});
  const after = createFieldSampler(changed, {coverage: {id: 'weight', sort: 'scalar'}})(context);
  assert.equal(after.coverage.value, sample.coverage.value * 2);
  assert.deepEqual(sampler(context), sample);
  assert.deepEqual(createFieldSampler(graph, {})(context), {});
});

test('multi-output preparation preserves color identity, low bits and hidden lazy failures', () => {
  const ink = color.linear([.2, .3, .7]);
  const shade = () => color.adjust(ink, {lightness: .04, chroma: .8, hue: 19});
  const a = named('a', shade()), b = named('b', shade());
  const graph = expressionGraph(named('mixed', color.mix(a, b, .35, {space: 'oklab'})));
  createFieldSampler(graph, {prior: {id: 'a', sort: 'color'}})(context);
  const sample = createFieldSampler(graph, {a: {id: 'a', sort: 'color'}, b: {id: 'b', sort: 'color'},
    mixed: {id: 'mixed', sort: 'color'}})(context);
  assert.notEqual(prepareFieldPoint(graph, 'a').point, prepareFieldPoint(graph, 'b').point);
  assert.deepEqual(sample.mixed, ordinary(graph, 'mixed'));
  assert.notDeepEqual(sample.mixed.value, sample.a.value);
  const giant = domain.transform([1e20, 0, 0, 0, 0, 1e20, 0, 0, 0, 0, 1e20, 0, 0, 0, 0, 1]);
  const unavailable = named('unavailable', scalar.axis('x', giant));
  const hidden = color.mix(ink, shade(), unavailable);
  const lazy = expressionGraph(named('visible', color.mix(ink, hidden, scalar.parameter(0))));
  const overflowing = {position: [1e20, 1e20, 1e20]};
  const visible = createFieldSampler(lazy, {ink: {id: 'visible', sort: 'color'}});
  assert.deepEqual(visible(overflowing).ink.value, [.2, .3, .7]);
  const both = createFieldSampler(lazy, {ink: {id: 'visible', sort: 'color'}, bad: {id: 'unavailable', sort: 'scalar'}});
  assert.throws(() => both(overflowing), /transformed position/);
  assert.equal(both(context).bad.value, .5e20);
  assert.deepEqual(visible(overflowing).ink.value, [.2, .3, .7]);
});

test('output selectors check shape and sorts and preserve arbitrary own output names', () => {
  const graph = expressionGraph(named('x', scalar.axis('x')));
  assert.throws(() => createFieldSampler(graph, []), /plain object/);
  assert.throws(() => createFieldSampler(graph, {x: {id: 'x', sort: 'image'}}), /Expected scalar, color or domain/);
  assert.throws(() => createFieldSampler(graph, {x: {id: 'x', sort: 'scalar', typo: 1}}), /Unknown field root/);
  assert.throws(() => createFieldSampler(graph, {x: {id: 'missing', sort: 'scalar'}}), /Expected scalar node/);
  assert.throws(() => createFieldSampler(graph, {x: {id: 'x', sort: 'color'}}), /Expected color node/);
  const sample = createFieldSampler(graph, {['__proto__']: {id: 'x', sort: 'scalar'}})(context);
  assert.equal(Object.getPrototypeOf(sample), Object.prototype);
  assert(Object.hasOwn(sample, '__proto__'));
  assert.deepEqual(sample.__proto__, ordinary(graph, 'x'));
});

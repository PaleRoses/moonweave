import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scalar, color, domain, image, named, surface, expressionGraph, materialGraph,
  patchGraph, serializeGraph, foldGraph,
} from '../src/core/graph.mts';
import {createFieldSampler, evaluateScalar, evaluateColor, prepareFieldPoint} from '../src/core/evaluate.mts';
import {fieldAlgebra, sampleDomain, sampleField} from '../src/core/field-evaluate.mts';
import {normalizeNode, mapReferences} from '../src/core/algebra.mts';
import {structuralKey} from '../src/core/intern.mts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const context = {position: [.5, .25, 0], dx: [1, 0, 0], dy: [0, 1, 0]};
const ordinary = (graph, context, id) => sampleField(foldGraph(graph, fieldAlgebra, id), context);

test('distinct pure scalar branches prepare and compute one shared result without editing the authored graph', () => {
  const gain = named('gain', scalar.parameter(.7));
  const branch = () => scalar.multiply(scalar.axis('x'), gain);
  const graph = expressionGraph(scalar.add(named('left', branch()), named('right', branch())));
  const source = serializeGraph(graph), prepared = prepareFieldPoint(graph);
  assert.equal(prepared.sourceNodes, 6);
  assert.equal(prepared.preparedNodes, 4);
  assert.equal(prepared.sharedNodes, 2);
  const state = {base: sampleDomain(context), values: new Map()};
  assert.deepEqual(prepared.point(state), {value: .7, dx: 1.4, dy: 0});
  assert.equal(state.values.size, 3, 'one axis, one product and one sum compute in the sample');
  const originalState = {base: sampleDomain(context), values: new Map()};
  assert.deepEqual(foldGraph(graph, fieldAlgebra)(originalState), prepared.point(state));
  assert.equal(originalState.values.size, 5, 'general folds preserve authored identities');
  assert.equal(serializeGraph(graph), source);
  assert.ok(graph.nodes.some(node => node.id === 'left'));
  assert.ok(graph.nodes.some(node => node.id === 'right'));
  const sampler = createFieldSampler(graph);
  assert.equal(createFieldSampler(graph), sampler);
  assert.deepEqual(sampler({...context, position: [.25, .25, 0]}), {value: .35, dx: 1.4, dy: 0});
  assert.deepEqual(sampler(context), {value: .7, dx: 1.4, dy: 0});
  assert.ok(Object.isFrozen(sampler(context)));
});

test('equal editable leaves stay independent while their structural coordinate read shares', () => {
  const left = named('leftGain', scalar.parameter(.7)), right = named('rightGain', scalar.parameter(.7));
  const graph = expressionGraph(scalar.add(
    scalar.multiply(scalar.axis('x'), left), scalar.multiply(scalar.axis('x'), right),
  ));
  const prepared = prepareFieldPoint(graph);
  assert.equal(prepared.sourceNodes, 7);
  assert.equal(prepared.preparedNodes, 6);
  const before = createFieldSampler(graph), edited = patchGraph(graph, {leftGain: {value: .9}});
  assert.equal(before(context).value, .7);
  assert.equal(createFieldSampler(edited)(context).value, .8);
  assert.equal(before(context).value, .7);
  assert.deepEqual(createFieldSampler(edited)(context), ordinary(edited, context));
  assert.equal(edited.nodes.find(node => node.id === 'rightGain').value, .7);
});

test('image-reader CSE retains channel, filtering, address, frame and resource identities', () => {
  const resource = {width: 2, height: 2, channels: 3, data: [
    0, 1, .2, 1, 0, .3, .4, .8, .7, .9, .1, .6,
  ]};
  const atlas = named('atlas', image.data(resource)), alternate = named('alternate', image.data(resource));
  const frame = named('frame', domain.transform(identity)), otherFrame = domain.transform(identity);
  const read = options => scalar.image(atlas, {domain: frame, ...options});
  const readers = [
    read({}), read({filter: 'linear'}), read({channel: 'g'}), read({address: 'zero'}),
    read({filter: 'trilinear'}), read({filter: 'anisotropic'}),
    scalar.image(atlas, {domain: otherFrame}), scalar.image(alternate, {domain: frame}),
  ];
  const graph = expressionGraph(readers.reduce((a, b) => scalar.add(a, b)));
  assert.equal(prepareFieldPoint(graph).sharedNodes, 1, 'only omitted/explicit linear readers coincide');
  const sampler = createFieldSampler(graph);
  const contexts = [context,
    {...context, position: [-.2, .7, 0]},
    {...context, footprint: {dx: [.8, .1, 0], dy: [0, .4, 0]}},
  ];
  for (const sample of contexts) assert.deepEqual(sampler(sample), ordinary(graph, sample));
  const matrix = [...identity]; matrix[12] = .2;
  const edited = patchGraph(graph, {frame: {matrix}, atlas: {resource: {...resource, data: resource.data.map(value => value * .5)}}});
  for (const sample of contexts) {
    assert.deepEqual(createFieldSampler(edited)(sample), ordinary(edited, sample));
    assert.deepEqual(sampler(sample), ordinary(graph, sample));
  }
  assert.equal(edited.nodes.find(node => node.id === 'alternate'), graph.nodes.find(node => node.id === 'alternate'));
});

test('named field roots prepare only reachable inputs and cache separately from material output', () => {
  const gain = scalar.parameter(.7);
  const graph = materialGraph(surface.channels(surface.paint(), {
    roughness: named('roughness', scalar.add(scalar.multiply(scalar.axis('x'), gain), scalar.multiply(scalar.axis('x'), gain))),
    metalness: named('metalness', scalar.axis('y')),
  }));
  assert.equal(prepareFieldPoint(graph, 'roughness').sourceNodes, 6);
  assert.equal(prepareFieldPoint(graph, 'roughness').preparedNodes, 4);
  assert.deepEqual(evaluateScalar(graph, 'roughness', context), {value: .7, dx: 1.4, dy: 0});
  assert.deepEqual(evaluateScalar(graph, 'metalness', context), {value: .25, dx: 0, dy: 1});
  assert.throws(() => evaluateColor(graph, 'roughness'), /Expected color/);
  assert.throws(() => evaluateScalar(graph, 'missing'), /Expected scalar/);
  assert.throws(() => createFieldSampler(graph), /received surface/);
});

test('color identity keeps the authored Oklab conversion and its exact numeric result', () => {
  const ink = color.linear([.2, .3, .7]);
  const shade = () => color.adjust(ink, {lightness: .04, chroma: .8, hue: 19});
  const a = shade(), b = shade(), graph = expressionGraph(color.mix(a, b, .35, {space: 'oklab'}));
  const prepared = prepareFieldPoint(graph);
  assert.equal(prepared.sharedNodes, 3, 'only three duplicated scalar constants share');
  const expected = ordinary(graph, context), actual = createFieldSampler(graph)(context);
  assert.deepEqual(actual, expected);
  assert.notDeepEqual(actual.value, createFieldSampler(a)(context).value,
    'merging these color points would remove an authored conversion and change low bits');
});

test('scalar sharing preserves lazy color masks and original shared-color identities', () => {
  const ink = color.linear([.2, .3, .7]);
  const shade = () => color.adjust(ink, {lightness: .04, chroma: .8, hue: 19});
  const giant = domain.transform([1e20, 0, 0, 0, 0, 1e20, 0, 0, 0, 0, 1e20, 0, 0, 0, 0, 1]);
  const unavailable = scalar.axis('x', giant), overflowing = {position: [1e20, 1e20, 1e20]};
  const shared = shade();
  for (const expression of [
    color.mix(shared, shared, unavailable, {space: 'oklab'}),
    color.ramp(unavailable, [[0, shared], [1, shared]], {space: 'oklab'}),
  ]) assert.deepEqual(createFieldSampler(expression)(overflowing), createFieldSampler(shared)(overflowing));
  for (const expression of [
    color.mix(shade(), shade(), unavailable, {space: 'oklab'}),
    color.ramp(unavailable, [[0, shade()], [1, shade()]], {space: 'oklab'}),
  ]) assert.throws(() => createFieldSampler(expression)(overflowing), /transformed position/);
  const branch = color.mix(ink, shade(), unavailable), weight = named('weight', scalar.parameter(0));
  const graph = expressionGraph(color.mix(ink, branch, weight));
  assert.deepEqual(createFieldSampler(graph)(overflowing).value, [.2, .3, .7]);
  assert.throws(() => createFieldSampler(patchGraph(graph, {weight: {value: .5}}))(overflowing), /transformed position/);
});

test('scalar CSE preserves arithmetic grouping and cancellation behavior', () => {
  const a = scalar.parameter(1e20), b = scalar.parameter(-1e20), c = scalar.parameter(1);
  assert.equal(createFieldSampler(scalar.add(scalar.add(a, b), c))().value, 1);
  assert.equal(createFieldSampler(scalar.add(a, scalar.add(b, c)))().value, 0);
  const tiny = scalar.parameter(2 ** -60);
  assert.equal(createFieldSampler(scalar.complement(scalar.complement(tiny)))().value, 0);
  assert.equal(createFieldSampler(tiny)().value, 2 ** -60);
});

test('structural keys ignore node names, retain literal semantics and reject value-based sharing', () => {
  const key = node => structuralKey(normalizeNode(node));
  assert.equal(key({id: 'first', kind: 'constant', value: 1}), key({id: 'second', kind: 'constant', value: 1}));
  assert.notEqual(key({id: 'first', kind: 'constant', value: 1}), key({id: 'first', kind: 'constant', value: 2}));
  assert.equal(key({id: 'first', kind: 'parameter', value: 1}), undefined);
  assert.equal(key({id: 'first', kind: 'color', value: [1, 0, 0]}), undefined);
  assert.notEqual(key({id: 'sum', kind: 'add', a: 'left', b: 'right'}), key({id: 'sum', kind: 'add', a: 'right', b: 'left'}));
  assert.equal(key({id: 'reader', kind: 'imageScalar', image: 'atlas'}),
    key({id: 'other', kind: 'imageScalar', image: 'atlas', address: 'clamp', channel: 'r', filter: 'linear'}));
  assert.notEqual(key({id: 'reader', kind: 'imageScalar', image: 'atlas'}),
    key({id: 'reader', kind: 'imageScalar', image: 'atlas', filter: 'trilinear'}));
});

test('structural key reference mapping matches canonical port rewriting without copying a node', () => {
  const nodes = [
    {id: 'axis', kind: 'axis', axis: 'x'},
    {id: 'read', kind: 'imageScalar', image: 'atlas', domain: 'frame', address: 'repeat', filter: 'anisotropic'},
    {id: 'mix', kind: 'colorMix', a: 'left', b: 'right', mask: 'mask', space: 'oklab'},
    {id: 'finish', kind: 'channels', input: 'base', values: {opacity: 'opacity', roughness: 'roughness'}},
  ].map(normalizeNode);
  const ids = new Map(['atlas', 'frame', 'left', 'right', 'mask', 'base', 'opacity', 'roughness'].map((id, index) => [id, index]));
  for (const node of nodes) {
    const before = JSON.stringify(node);
    assert.equal(structuralKey(node, id => id), structuralKey(node));
    assert.equal(structuralKey(node, id => ids.get(id)), structuralKey(mapReferences(node, id => ids.get(id))));
    assert.equal(JSON.stringify(node), before);
  }
  // The current list-port operation has editable stop positions and is never
  // interned, even when its color inputs and positions happen to match.
  const ramp = normalizeNode({id: 'ramp', kind: 'colorRamp', input: 'mask', colors: ['left', 'right'], positions: [0, 1]});
  assert.equal(structuralKey(ramp, () => assert.fail('editable nodes must not map their ports')), undefined);
});

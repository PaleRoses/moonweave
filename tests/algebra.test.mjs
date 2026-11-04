import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SURFACE_SIGNATURE, scalar, domain, facets, surface, materialGraph,
  compileGraph, serializeGraph, patchGraph, evaluateScalar, evaluateDomain, foldGraph, inDomain,
} from '../src/core.mjs';
import {foldDag, mapReferences} from '../src/core/algebra.mts';
import {fieldAlgebra, sampleField} from '../src/core/field-evaluate.mts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const scalarGraph = expression => materialGraph(surface.channels(surface.paint(), {roughness: expression}));
const scalarRoot = graph => graph.nodes.find(node => node.id === graph.output).values.roughness;

function composition(frame) {
  const field = facets({scale: .21, ...(frame ? {domain: frame} : {})});
  const mask = scalar.multiply(scalar.parameter(.73), scalar.ramp(scalar.axis('y', frame), -.4, .6));
  return surface.mix(surface.paint(field, 'carapace'), surface.paint(field, 'horn'), mask);
}

test('reference mapping obeys identity and composition while leaving payloads untouched', () => {
  const graph = materialGraph(surface.channels(composition(), {metalness: scalar.parameter(.3)}));
  const f = id => `a_${id}`, g = id => `b_${id}`;
  for (const node of graph.nodes) {
    assert.equal(mapReferences(node, id => id), node);
    assert.deepEqual(mapReferences(mapReferences(node, f), g), mapReferences(node, id => g(f(id))));
  }
  const paint = graph.nodes.find(node => node.kind === 'paint');
  assert.equal(mapReferences(paint, f).style, paint.style);
});

test('a fold interprets each reachable shared node once and preserves interpreted sharing', () => {
  const shared = facets(), weight = scalar.parameter(.4);
  const source = materialGraph(surface.mix(surface.paint(shared), surface.paint(shared, 'horn'), weight));
  const graph = materialGraph({...source, nodes: [...source.nodes, {id: 'unused', kind: 'parameter', value: .1}]});
  const calls = new Map();
  const count = (node, result) => { calls.set(node.id, (calls.get(node.id) ?? 0) + 1); return result; };
  const algebra = {
    facets: node => count(node, {sample: node.id}),
    color: node => count(node, node.value),
    paint: node => count(node, {field: node.field, base: node.palette.base}),
    parameter: node => count(node, node.value),
    mix: node => count(node, {a: node.a, b: node.b, weight: node.mask}),
  };
  const result = foldGraph(graph, algebra);
  assert.equal(result.a.field, result.b.field);
  assert.equal(result.weight, .4);
  assert.equal(calls.size, source.nodes.length);
  assert([...calls.values()].every(count => count === 1));
  assert.equal(calls.has('unused'), false);
  assert.throws(() => foldGraph(graph, {...algebra, facets: undefined}), /does not interpret facets/);
  assert.throws(() => foldGraph(graph, algebra, 'missing'), /Unknown graph root/);
});

test('one retained fold memo extends across roots without rereading shared descendants', () => {
  const nodes = new Map([
    ['value', {id: 'value', kind: 'parameter', value: .25}],
    ['first', {id: 'first', kind: 'add', a: 'value', b: 'value'}],
    ['second', {id: 'second', kind: 'multiply', a: 'first', b: 'value'}],
  ]);
  for (const order of [['value', 'first', 'second'], ['second', 'first', 'value']]) {
    const memo = new Map(), reads = [];
    const read = id => { reads.push(id); return nodes.get(id); };
    const reduce = node => node.kind === 'parameter' ? node.value
      : node.kind === 'add' ? node.a + node.b : node.a * node.b;
    const results = Object.fromEntries(order.map(id => [id, foldDag(id, read, reduce, memo)]));
    assert.deepEqual(results, {value: .25, first: .5, second: .125});
    assert.equal(reads.length, 3);
    assert.equal(new Set(reads).size, 3);
    assert.equal(foldDag('second', read, reduce), .125, 'the default fold keeps an independent memo');
    assert.equal(reads.length, 6);
  }
});

test('an independent numeric interpretation agrees with scalar sampling', () => {
  const expression = scalar.multiply(scalar.ramp(scalar.axis('x'), -.8, .9), scalar.add(scalar.axis('y'), .25));
  const graph = scalarGraph(expression), root = scalarRoot(graph);
  for (let index = 0; index < 31; index++) {
    const position = [Math.sin(index), Math.cos(index * .7), 0];
    const algebra = {
      constant: node => node.value,
      parameter: node => node.value,
      axis: node => position[{x: 0, y: 1, z: 2}[node.axis]],
      add: node => node.a + node.b,
      multiply: node => node.a * node.b,
      complement: node => 1 - node.input,
      ramp: node => {
        const x = Math.max(0, Math.min(1, (node.input - node.low) / (node.high - node.low)));
        return x * x * (3 - 2 * x);
      },
    };
    assert.equal(foldGraph(graph, algebra, root), evaluateScalar(graph, root, {position}).value);
  }
});

test('compiled point functions share one computed value per sample, without sharing sample state', () => {
  const shared = scalar.multiply(scalar.axis('x'), scalar.parameter(.25));
  const graph = scalarGraph(scalar.add(shared, shared)), observations = [];
  const point = foldGraph(graph, {
    ...fieldAlgebra,
    add: (node, source) => {
      const add = fieldAlgebra.add(node, source);
      return state => {
        observations.push([node.a(state), node.b(state)]);
        return add(state);
      };
    },
  }, scalarRoot(graph));
  assert.deepEqual(sampleField(point, {position: [2, 0, 0], dx: [1, 0, 0]}), {value: 1, dx: .5, dy: 0});
  assert.deepEqual(sampleField(point, {position: [4, 0, 0], dx: [2, 0, 0]}), {value: 2, dx: 1, dy: 0});
  assert.equal(observations[0][0], observations[0][1]);
  assert.equal(observations[1][0], observations[1][1]);
  assert.notEqual(observations[0][0], observations[1][0]);
});

test('cached point functions isolate roots, edited values and fresh mutable sample contexts', () => {
  const gain = scalar.parameter(2), x = scalar.axis('x'), y = scalar.axis('y');
  const graph = materialGraph(surface.channels(surface.paint(), {
    roughness: scalar.multiply(scalar.add(x, y), gain), metalness: y,
  }));
  const roots = graph.nodes.find(node => node.id === graph.output).values;
  const parameter = graph.nodes.find(node => node.kind === 'parameter').id;
  const context = {position: [1, 2, 0], dx: [1, 0, 0], dy: [0, 1, 0]};
  const first = evaluateScalar(graph, roots.roughness, context);
  assert.deepEqual(first, {value: 6, dx: 2, dy: 2});
  context.position[0] = 4;
  assert.deepEqual(evaluateScalar(graph, roots.roughness, context), {value: 12, dx: 2, dy: 2});
  assert.deepEqual(evaluateScalar(graph, roots.metalness, context), {value: 2, dx: 0, dy: 1});
  const edited = patchGraph(graph, {[parameter]: {value: 3}});
  assert.deepEqual(evaluateScalar(edited, roots.roughness, context), {value: 18, dx: 3, dy: 3});
  assert.deepEqual(evaluateScalar(graph, roots.roughness, context), {value: 12, dx: 2, dy: 2});
  assert.deepEqual(first, {value: 6, dx: 2, dy: 2});
  assert(Object.isFrozen(first));
  context.position[0] = NaN;
  assert.throws(() => evaluateScalar(graph, roots.roughness, context), /sample position/);
  context.position[0] = 1;
  assert.equal(evaluateScalar(graph, roots.roughness, context).value, 6);
  assert.throws(() => evaluateDomain(graph, roots.roughness), /Expected domain/);
});

test('the expression-building interpretation round-trips graph structure and sharing', () => {
  const graph = materialGraph(composition(domain.transform(identity)));
  const rebuild = Object.fromEntries(Object.keys(SURFACE_SIGNATURE).map(kind => [kind, ({id, ...node}) => node]));
  const restored = materialGraph(foldGraph(graph, rebuild));
  assert.equal(serializeGraph(restored), serializeGraph(graph));
  assert.equal(compileGraph(restored).programKey, compileGraph(graph).programKey);
  assert.equal(restored.nodes.filter(node => node.kind === 'facets').length, 1);
});

test('domain binding has a true no-op identity and leaves coordinate-free values shared', () => {
  const expression = composition(), value = scalar.constant(.2), frame = domain.transform(identity);
  assert.equal(inDomain(expression), expression);
  assert.equal(inDomain(value, frame), value);
});

test('domain binding moves a complete paint and mask together without duplicating fields', () => {
  const matrix = [...identity]; matrix[0] = 1.7; matrix[12] = -.2;
  const frame = domain.transform(matrix);
  const bound = materialGraph(inDomain(composition(), frame));
  const explicit = materialGraph(composition(frame));
  assert.equal(serializeGraph(bound), serializeGraph(explicit));
  assert.equal(compileGraph(bound).programKey, compileGraph(explicit).programKey);
  assert.equal(compileGraph(bound).cost.textureReads, 4);
  const field = bound.nodes.find(node => node.kind === 'facets');
  const axis = bound.nodes.find(node => node.kind === 'axis');
  assert.equal(field.domain, axis.domain);
  assert.equal(bound.nodes.filter(node => node.kind === 'transform').length, 1);
});

test('domain substitution composes in order without fusing floating-point matrix operations', () => {
  const inner = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, .5, 0, 1, 2, 3, 1];
  const outer = [1, 0, 0, 0, .5, 1, 0, 0, 0, 0, 1, 0, -2, 1, 0, 1];
  const a = domain.transform(outer), b = domain.transform(inner), expression = composition();
  const twice = materialGraph(inDomain(inDomain(expression, a), b));
  const associated = materialGraph(inDomain(expression, inDomain(a, b)));
  assert.equal(serializeGraph(twice), serializeGraph(associated));
  assert.equal(twice.nodes.filter(node => node.kind === 'transform').length, 2);
  const frame = twice.nodes.find(node => node.kind === 'facets').domain;
  const result = evaluateDomain(twice, frame, {position: [1, 2, 3], dx: [1, 0, 0], dy: [0, 1, 0]});
  assert.deepEqual(result.position, [5, 9, 4.5]);
  assert.deepEqual(result.dx, [2, 0, 0]);
  assert.deepEqual(result.dy, [1.5, 3, 0]);
});

test('domain binding snapshots raw inputs without freezing or mutating authors data', () => {
  const expression = {kind: 'axis', axis: 'x'}, matrix = [...identity]; matrix[0] = 2;
  const frame = {kind: 'transform', matrix};
  const bound = inDomain(expression, frame);
  expression.axis = 'y'; matrix[0] = 9;
  assert.equal(Object.isFrozen(expression), false);
  assert.equal(Object.isFrozen(matrix), false);
  const graph = scalarGraph(bound);
  assert.equal(evaluateScalar(graph, scalarRoot(graph), {position: [3, 7, 0]}).value, 6);
  const cycle = {kind: 'complement'}; cycle.input = cycle;
  assert.throws(() => inDomain(cycle, domain.transform(identity)), /Cyclic/);
  assert.throws(() => inDomain(scalar.axis(), scalar.constant(1)), /domain expression/);
});

test('arithmetic keeps its authored grouping; floating-point numbers are not a ring', () => {
  const a = scalar.parameter(1e20), b = scalar.parameter(-1e20), c = scalar.parameter(1);
  const left = scalarGraph(scalar.add(scalar.add(a, b), c));
  const right = scalarGraph(scalar.add(a, scalar.add(b, c)));
  assert.equal(evaluateScalar(left, scalarRoot(left)).value, 1);
  assert.equal(evaluateScalar(right, scalarRoot(right)).value, 0);
  assert.notEqual(compileGraph(left).programKey, compileGraph(right).programKey);
});

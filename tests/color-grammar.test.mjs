import test from 'node:test';
import assert from 'node:assert/strict';
import {
  color, scalar, surface, domain, facets, named, inDomain, materialGraph,
  compileGraph, patchGraph, parseGraph, serializeGraph, foldGraph, PALETTE_KEYS,
} from '../src/core.mjs';
import {mapReferences, nodeReferences} from '../src/core/algebra.mts';

const graphOf = color => materialGraph(surface.material(color));
const read = (graph, id) => graph.nodes.find(node => node.id === id);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('Color remains extended linear RGB until a material boundary', () => {
  const extended = [-1e20, .25, 1e20];
  const graph = graphOf(named('extended', color.linear(extended)));
  assert.deepEqual(read(graph, 'extended').value, extended);
  const edited = patchGraph(graph, {extended: {value: [-.2, 1.2, .4]}});
  assert.deepEqual(read(edited, 'extended').value, [-.2, 1.2, .4]);
  assert.throws(() => patchGraph(graph, {extended: {value: [0, 1e21, 0]}}), /color.value/);
});

test('canonical palette and mix defaults preserve their serialized representation', () => {
  const a = color.srgb('#134276'), b = color.srgb('#bada55');
  const ordinary = graphOf(color.mix(a, b, .3));
  const explicit = graphOf(color.mix(a, b, .3, {space: 'linear-rgb'}));
  assert.equal(serializeGraph(explicit), serializeGraph(ordinary));
  assert(!Object.hasOwn(ordinary.nodes.find(node => node.kind === 'colorMix'), 'space'));
  assert.equal(compileGraph(explicit).programKey, compileGraph(ordinary).programKey);
  assert.notEqual(compileGraph(graphOf(color.mix(a, b, .3, {space: 'oklab'}))).programKey,
    compileGraph(ordinary).programKey);

  const field = facets();
  const paint = materialGraph(surface.paint(field, 'carapace'));
  assert.equal(serializeGraph(paint), serializeGraph(surface.paint(field, 'carapace', {})));
  assert.deepEqual(Object.keys(read(paint, paint.output).palette), ['base', 'shadow', 'light']);
  assert(!Object.hasOwn(read(paint, paint.output).style, 'palette'));
  assert.deepEqual(PALETTE_KEYS, ['base', 'shadow', 'light']);
});

test('color ramps own stop data while sharing expression inputs and serializing explicit defaults', () => {
  const first = named('first', color.srgb('#132435')), second = named('second', color.srgb('#a7b8c9'));
  const stops = [[-2, first], [0, second], [2, first]];
  const ramp = named('ramp', color.ramp(scalar.noise({seed: 9}), stops));
  stops[0][0] = -3;
  stops.push([4, second]);
  assert.equal(Object.isFrozen(stops), false);
  assert.deepEqual(ramp.positions, [-2, 0, 2]);
  assert.equal(ramp.colors[0], ramp.colors[2]);
  assert.equal(ramp.colors[0], first);
  const graph = graphOf(ramp), stored = read(graph, 'ramp');
  assert.deepEqual(stored.colors, ['first', 'second', 'first']);
  assert.deepEqual(stored.positions, [-2, 0, 2]);
  assert.equal(stored.space, 'linear-rgb');
  assert.equal(stored.interpolation, 'linear');
  assert(Object.isFrozen(stored.colors));
  assert(Object.isFrozen(stored.positions));
  assert.equal(graph.nodes.filter(node => node.kind === 'color').length, 2);
  assert.equal(serializeGraph(parseGraph(serializeGraph(graph))), serializeGraph(graph));
});

test('ramps validate arity, stop order, float32 separation and typed list references', () => {
  const a = color.linear([0, 0, 0]), b = color.linear([1, 1, 1]);
  const ramp = (stops, options) => graphOf(color.ramp(0, stops, options));
  for (const stops of [[], [[0, a]], Array.from({length: 17}, (_, i) => [i, a])]) {
    assert.throws(() => ramp(stops), /2–16/);
  }
  for (const positions of [[1, 0], [0, 0], [0, 1e-7], [1e10, 1e10 + 1], [0, NaN], [0, Infinity]]) {
    assert.throws(() => ramp([[positions[0], a], [positions[1], b]]), /position/);
  }
  assert.throws(() => ramp([[0, a], [1, scalar.parameter(.5)]]), /expects color, received scalar/);
  assert.throws(() => ramp([[0, a], [1, () => b]]), /not callbacks/);
  assert.throws(() => color.ramp(0, [[0, a], undefined]), /pairs/);
  assert.throws(() => ramp([[0, a], [1, b]], {space: 'srgb'}), /Color space/);
  assert.throws(() => ramp([[0, a], [1, b]], {interpolation: 'spline'}), /Color interpolation/);
  assert.throws(() => color.ramp(0, [[0, a], [1, b]], {interpolaton: 'linear'}), /Unknown color ramp/);
  assert.throws(() => graphOf(color.mix(a, b, .5, {space: null})), /Color space/);

  const valid = graphOf(named('ramp', color.ramp(0, [[0, a], [1, b]])));
  for (const patch of [{positions: [0]}, {positions: [0, , 1]}, {colors: ['missing', 'also_missing']}, {colors: [read(valid, 'ramp').colors[0], ]}]) {
    assert.throws(() => materialGraph({...valid, nodes: valid.nodes.map(node => node.id === 'ramp' ? {...node, ...patch} : node)}));
  }
  assert.throws(() => materialGraph({...valid, nodes: [...valid.nodes,
    {id: 'bad_unused', kind: 'colorRamp', input: read(valid, 'ramp').input,
      colors: read(valid, 'ramp').colors, positions: [0, 0]}]}), /positions/);
});

test('stop edits preserve structure and untouched nodes, while invalid edits remain atomic', () => {
  const graph = graphOf(named('ramp', color.ramp(scalar.parameter(.4), [
    [0, named('dark', color.linear([.1, .2, .3]))],
    [.5, named('mid', color.linear([.3, .4, .5]))],
    [1, named('light', color.linear([.7, .8, .9]))],
  ], {space: 'oklab', interpolation: 'smoothstep'})));
  const plan = compileGraph(graph), before = serializeGraph(graph);
  assert.equal(patchGraph(graph, {ramp: {positions: [0, .5, 1]}}), graph);
  const edited = patchGraph(graph, {ramp: {positions: [-1, .4, 2]}}), next = compileGraph(edited);
  assert.equal(next.structure, plan.structure);
  assert.equal(next.programKey, plan.programKey);
  assert.deepEqual(next.nodes.find(node => node.kind === 'colorRamp').positions, [-1, .4, 2]);
  assert.equal(read(edited, 'dark'), read(graph, 'dark'));
  assert.equal(next.cost.uniformScalars, 13);
  assert.throws(() => patchGraph(graph, {dark: {value: [.4, .5, .6]}, ramp: {positions: [0, 0, 1]}}), /positions/);
  assert.equal(serializeGraph(graph), before);
  for (const patch of [{colors: ['dark', 'light']}, {space: 'linear-rgb'}, {interpolation: 'constant'}]) {
    assert.throws(() => patchGraph(graph, {ramp: patch}), /Unknown ramp value patch/);
  }
});

test('the same-reference ramp law preserves the retained color binding rather than the ramp binding', () => {
  const ink = named('ink', color.linear([.2, .3, .4]));
  const graph = graphOf(named('redundant', color.ramp(scalar.noise({seed: 8}), [[0, ink], [1, ink]])));
  const plan = compileGraph(graph);
  assert.deepEqual(plan.nodes.map(node => node.kind), ['color', 'material']);
  assert.deepEqual(plan.bindings.map(binding => binding.sourceId), ['ink']);
  assert.deepEqual(plan.nodes[0].value, [.2, .3, .4]);
  const edited = compileGraph(patchGraph(graph, {ink: {value: [.6, .7, .8]}, redundant: {positions: [-2, 2]}}));
  assert.equal(edited.structure, plan.structure);
  assert.deepEqual(edited.nodes[0].value, [.6, .7, .8]);
  assert.deepEqual(edited.cost, {paintSamples: 0, proceduralSamples: 0, textureReads: 0, uniformScalars: 3});

  const independent = graphOf(color.ramp(0, [
    [0, color.linear([.2, .3, .4])], [1, color.linear([.2, .3, .4])],
  ]));
  assert.equal(compileGraph(independent).nodes.filter(node => node.kind === 'color').length, 2);
  assert(compileGraph(independent).nodes.some(node => node.kind === 'colorRamp'));
});

test('editable stop positions prevent a literal ramp input from specializing its current endpoint', () => {
  const graph = graphOf(named('ramp', color.ramp(0, [
    [0, color.linear([0, 0, 0])], [1, color.linear([1, 1, 1])],
  ])));
  const before = compileGraph(graph), after = compileGraph(patchGraph(graph, {ramp: {positions: [-1, 1]}}));
  assert(before.nodes.some(node => node.kind === 'colorRamp'));
  assert.equal(after.programKey, before.programKey);
  assert.deepEqual(after.nodes.find(node => node.kind === 'colorRamp').positions, [-1, 1]);
});

test('typed paint palettes connect color fields to the original sampled facets', () => {
  const ink = named('ink', color.linear([-.2, .5, 1.2]));
  const graph = materialGraph(named('paint', surface.paint(facets(), 'carapace', {shadow: ink, base: ink})));
  assert.equal(read(graph, 'paint').palette.base, 'ink');
  assert.equal(read(graph, 'paint').palette.shadow, 'ink');
  assert.equal(read(graph, read(graph, 'paint').palette.light).kind, 'color');
  assert.equal(graph.nodes.filter(node => node.kind === 'color').length, 2);
  assert.equal(compileGraph(graph).cost.uniformScalars, 26);
  assert.equal(compileGraph(graph).cost.paintSamples, 1);
  const preset = materialGraph(surface.paint('carapace', {palette: {base: ink}}));
  assert.equal(read(preset, preset.output).palette.base, 'ink');
  assert.throws(() => materialGraph(surface.paint(facets(), 'carapace', {base: scalar.parameter(.4)})), /expects color, received scalar/);
  assert.throws(() => surface.paint(facets(), 'carapace', {unknown: ink}), /Unknown paint palette/);
  assert.throws(() => surface.paint('carapace', {}, {base: ink}), /options/);
  assert.throws(() => materialGraph({...graph, nodes: graph.nodes.map(node => node.id === 'paint' ? {...node, palette: null} : node)}), /plain object/);
  assert.throws(() => patchGraph(graph, {paint: {palette: {base: 'other'}}}), /Unknown paint value patch/);
  assert.equal(compileGraph(patchGraph(graph, {ink: {value: color.srgb('#abcdef').value}})).programKey,
    compileGraph(graph).programKey);
  assert.throws(() => facets({stretch: [1, , 1]}), /stretch/);
});

test('list and record ports obey reference laws and whole-expression domain binding', () => {
  const noise = named('noise', scalar.noise({seed: 4}));
  const ink = named('ink', color.srgb('#345678'));
  const ramp = named('ramp', color.ramp(noise, [[0, ink], [1, color.mix(ink, color.srgb('#abcdef'), noise)]]));
  const source = surface.paint(facets(), 'carapace', {base: ramp, shadow: ink});
  const frame = domain.transform(identity), bound = inDomain(source, frame), graph = materialGraph(bound);
  assert.equal(bound.palette.shadow, ink);
  assert.equal(bound.palette.base.input, bound.palette.base.colors[1].mask);
  assert.equal(bound.palette.base.input.domain, frame);
  assert.equal(bound.field.domain, frame);
  assert.equal(graph.nodes.filter(node => node.kind === 'noise').length, 1);
  assert.equal(graph.nodes.filter(node => node.kind === 'transform').length, 1);
  for (const node of graph.nodes) {
    const f = id => `f_${id}`, g = id => `g_${id}`;
    assert.equal(mapReferences(node, id => id), node);
    assert.deepEqual(mapReferences(mapReferences(node, f), g), mapReferences(node, id => g(f(id))));
  }
  assert.deepEqual(nodeReferences(read(graph, 'ramp')).map(edge => edge.key), ['input', 'colors[0]', 'colors[1]']);
  const visits = new Map();
  const result = foldGraph(graph, new Proxy({}, {get: (_, kind) => (node, source) => {
    visits.set(source.id, (visits.get(source.id) ?? 0) + 1);
    return {kind, ...node};
  }}));
  assert.equal(result.palette.base.input, result.palette.base.colors[1].mask);
  assert.equal(result.palette.shadow, result.palette.base.colors[0]);
  assert.equal(visits.size, graph.nodes.length);
  assert([...visits.values()].every(count => count === 1));
});

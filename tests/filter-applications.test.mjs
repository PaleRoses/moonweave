import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoot} from 'solid-js';
import {
  color, compileGraph, createFieldSampler, domain, expressionGraph, graphExpression,
  image, inDomain, instantiate, materialGraph, named, parseGraph, patchGraph,
  scalar, serializeGraph, surface,
} from '../src/core.mjs';
import {inscribedGlaze} from '../lab/application-examples.mts';
import {createEditor} from '../lab/editor.ts';

const near = (a, b, tolerance = 1e-11) => assert(Math.abs(a - b) <= tolerance,
  `${a} differs from ${b}`);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('the packed application serializes one atlas and shares each placed channel reconstruction', () => {
  const graph = inscribedGlaze(), restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(restored, graph);
  const resources = restored.nodes.filter(node => node.kind === 'image');
  const readers = restored.nodes.filter(node => node.kind === 'imageScalar');
  assert.equal(resources.length, 1);
  assert.equal(resources[0].resource.channels, 3);
  assert.equal(readers.length, 6);
  assert.equal(new Set(readers.map(node => node.domain)).size, 2);
  assert(readers.every(node => node.image === resources[0].id && node.filter === 'anisotropic' && node.address === 'zero'));
  for (const frame of new Set(readers.map(node => node.domain))) {
    assert.deepEqual(readers.filter(node => node.domain === frame).map(node => node.channel).sort(), ['b', 'g', 'r']);
  }
  assert.equal(compileGraph(restored).cost.textureReads, 132);
  assert.equal(compileGraph(inscribedGlaze('linear')).cost.textureReads, 12);
});

test('a restored application keeps its shared resource across independent creature frames and local edits', () => {
  const restored = parseGraph(serializeGraph(inscribedGlaze()));
  const template = graphExpression(restored), atlas = graphExpression(restored, 'inscriptionAtlas');
  const frame = [...identity]; frame[0] = .5; frame[5] = 1.5; frame[12] = .2;
  const left = instantiate(inDomain(template, domain.transform(frame)), {prefix: 'left', shared: [atlas]});
  const right = instantiate(inDomain(template, domain.transform(identity)), {prefix: 'right', shared: [atlas]});
  const combined = materialGraph(surface.mix(left, right, .5));
  assert.equal(combined.nodes.filter(node => node.kind === 'image').length, 1);
  const readers = combined.nodes.filter(node => node.kind === 'imageScalar');
  assert.equal(readers.length, 12);
  assert(readers.every(node => node.image === 'inscriptionAtlas' && node.filter === 'anisotropic'));
  const updated = patchGraph(combined, {left_inscriptionDepth: {value: -.002}});
  assert.equal(updated.nodes.find(node => node.id === 'left_inscriptionDepth').value, -.002);
  assert.equal(updated.nodes.find(node => node.id === 'right_inscriptionDepth').value, .0016);
  assert.equal(compileGraph(updated).programKey, compileGraph(combined).programKey);
  assert.deepEqual(parseGraph(serializeGraph(updated)), updated);
});

test('domain binding transports the pixel footprint separately from calculus directions', () => {
  const pixels = image.generate({width: 7, height: 5, channels: 1}, (u, v) => .2 + u * v);
  const field = scalar.image(pixels, {filter: 'anisotropic', address: 'zero'});
  const matrix = [1.5, .25, 0, 0, -.125, .75, 0, 0, 0, 0, 1, 0, .125, -.125, 0, 1];
  const linear = value => [
    matrix[0] * value[0] + matrix[4] * value[1] + matrix[8] * value[2],
    matrix[1] * value[0] + matrix[5] * value[1] + matrix[9] * value[2],
    matrix[2] * value[0] + matrix[6] * value[1] + matrix[10] * value[2],
  ];
  const context = {position: [.3, .5, 0], dx: [1, .2, 0], dy: [.1, 1, 0],
    footprint: {dx: [.31, .04, 0], dy: [.02, .08, 0]}};
  const before = structuredClone(context);
  const bound = createFieldSampler(inDomain(field, domain.transform(matrix)))(context);
  const explicit = createFieldSampler(field)({
    position: linear(context.position).map((component, i) => component + matrix[12 + i]),
    dx: linear(context.dx), dy: linear(context.dy),
    footprint: {dx: linear(context.footprint.dx), dy: linear(context.footprint.dy)},
  });
  for (const key of ['value', 'dx', 'dy']) near(bound[key], explicit[key]);
  assert.deepEqual(context, before);
});

test('one filtered value supports independent derivative directions and an omitted footprint remains a point query', () => {
  const pixels = image.generate({width: 16, height: 8, channels: 1}, (u, v) => u * v);
  const filtered = createFieldSampler(scalar.image(pixels, {filter: 'trilinear'}));
  const point = createFieldSampler(scalar.image(pixels));
  const context = {position: [.43, .56, 0], dx: [1, 0, 0], dy: [0, 1, 0],
    footprint: {dx: [.2, .02, 0], dy: [-.01, .13, 0]}};
  const basis = filtered(context);
  const other = filtered({...context, dx: [.3, -.2, 0], dy: [.4, .7, 0]});
  assert.equal(other.value, basis.value);
  near(other.dx, .3 * basis.dx - .2 * basis.dy);
  near(other.dy, .4 * basis.dx + .7 * basis.dy);
  const {footprint, ...withoutFootprint} = context;
  assert.deepEqual(filtered(withoutFootprint), point(withoutFootprint));
});

test('baking covered deposition before filtering retains its correlation', () => {
  const packed = image.generate({width: 8, height: 8, channels: 3}, (_u, _v, x, y) => {
    const mask = (x + y) % 2, height = mask;
    return [mask, mask * height, height];
  });
  const read = channel => scalar.image(packed, {filter: 'trilinear', address: 'repeat', channel});
  const context = {position: [.37, .61, 0], footprint: {dx: [1, 0, 0], dy: [0, 1, 0]}};
  const deposited = createFieldSampler(read('g'))(context).value;
  const composedLater = createFieldSampler(scalar.multiply(read('r'), read('b')))(context).value;
  near(deposited, .5);
  near(composedLater, .25);
  assert.notEqual(deposited, composedLater);
});

test('filter changes are structural and editor undo restores their resource and cost semantics', t => {
  const pixels = named('pixels', image.data({width: 2, height: 2, channels: 1, data: [0, 1, 1, 0]}));
  const omitted = materialGraph(surface.material(color.image(pixels)));
  const explicitLinear = materialGraph(surface.material(color.image(pixels, {filter: 'linear'})));
  assert.equal(serializeGraph(explicitLinear), serializeGraph(omitted));
  assert.throws(() => patchGraph(expressionGraph(named('sample', scalar.image(pixels))),
    {sample: {filter: 'trilinear'}}), /structural/);
  createRoot(dispose => {
    const editor = createEditor({commit() {}, invalidate() {}, frames: {request: () => 1, cancel() {}}});
    t.after(() => {editor.dispose(); dispose();});
    assert.equal(editor.useExample('inscription'), true);
    const original = editor.graph(), program = editor.plan().programKey;
    assert.equal(editor.filteredImages(), true);
    assert.equal(editor.plan().cost.textureReads, 132);
    editor.openSource();
    const changed = {...original, nodes: original.nodes.map(node => node.kind === 'imageScalar'
      ? {...node, filter: 'linear'} : node)};
    editor.editSource(JSON.stringify(changed));
    assert.equal(editor.applySource(), true);
    assert.equal(editor.filteredImages(), false);
    assert.equal(editor.plan().cost.textureReads, 12);
    assert.notEqual(editor.plan().programKey, program);
    assert.equal(editor.undo(), true);
    assert.equal(editor.graph(), original);
    assert.equal(editor.filteredImages(), true);
    assert.equal(editor.plan().programKey, program);
  });
});

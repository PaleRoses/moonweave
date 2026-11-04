import test from 'node:test';
import assert from 'node:assert/strict';
import {
  image, scalar, color, surface, named, materialGraph, expressionGraph,
  parseExpressionGraph, serializeGraph, patchGraph, compileGraph,
} from '../src/core.mjs';

const pixels = () => named('pixels', image.data({
  width: 2, height: 2, channels: 3,
  data: [.25, .4, .7, .5, .6, .8, .75, .7, .9, .5, .3, .6],
}));

test('explicit linear is the canonical legacy reader, with no document or program change', () => {
  const source = pixels();
  for (const create of [scalar.image, color.image]) {
    const original = create(source), explicit = create(source, {filter: 'linear'});
    assert.equal(Object.hasOwn(expressionGraph(explicit).nodes.at(-1), 'filter'), false);
    assert.equal(serializeGraph(expressionGraph(original)), serializeGraph(expressionGraph(explicit)));
  }
  const first = surface.material(color.image(source));
  const second = surface.material(color.image(source, {filter: 'linear'}));
  assert.equal(compileGraph(first).programKey, compileGraph(second).programKey);
});

test('filter declarations are checked at graph construction and import and survive JSON roundtrips', () => {
  const source = pixels();
  for (const filter of ['trilinear', 'anisotropic']) {
    const graph = expressionGraph(scalar.image(source, {filter, address: 'zero', channel: 'g'}));
    const restored = parseExpressionGraph(serializeGraph(graph));
    assert.equal(restored.nodes.at(-1).filter, filter);
    assert.equal(restored.nodes.at(-1).address, 'zero');
    assert.equal(serializeGraph(restored), serializeGraph(graph));
  }
  for (const filter of ['auto', 'ewa', 8, null]) {
    assert.throws(() => expressionGraph(scalar.image(source, {filter})), /Image filter must/);
    const document = JSON.parse(serializeGraph(expressionGraph(scalar.image(source))));
    document.nodes.at(-1).filter = filter;
    assert.throws(() => parseExpressionGraph(JSON.stringify(document)), /Image filter must/);
  }
  assert.throws(() => expressionGraph(color.image(source, {address: 'border'})), /Image address must/);
});

test('sampling policy is structure while dimensions and mip-producing pixels remain editable data', () => {
  const source = pixels();
  const graph = materialGraph(surface.material(named('reader', color.image(source, {filter: 'trilinear'}))));
  const plan = compileGraph(graph);
  const changed = patchGraph(graph, {pixels: {resource: {width: 3, height: 1, channels: 1, data: [.2, .4, .6]}}});
  assert.equal(compileGraph(changed).programKey, plan.programKey);
  assert.equal(compileGraph(changed).structure, plan.structure);
  assert.throws(() => patchGraph(graph, {reader: {filter: 'anisotropic'}}), /structural/);
  const anisotropic = materialGraph(surface.material(named('reader', color.image(source, {filter: 'anisotropic'}))));
  assert.notEqual(compileGraph(anisotropic).programKey, plan.programKey);
});

test('costs share channels of one filter policy and separate differing policies', () => {
  const source = pixels();
  const material = surface.channels(surface.material(color.image(source, {filter: 'anisotropic'})), {
    roughness: scalar.image(source, {filter: 'anisotropic', channel: 'g'}),
    metalness: scalar.image(source, {filter: 'trilinear', channel: 'b'}),
  });
  const plan = compileGraph(material);
  assert.equal(plan.nodes.filter(node => node.kind === 'image').length, 1);
  assert.equal(plan.cost.textureReads, 72); // 64 + 8 ceilings, not 64 + 64 + 8.
  for (const [filter, reads] of [['linear', 4], ['trilinear', 8], ['anisotropic', 64]]) {
    assert.equal(compileGraph(surface.material(color.image(source, {filter}))).cost.textureReads, reads);
  }
});

test('zero extension expands range analysis to zero, including signed height resources', () => {
  for (const values of [[.25, .75], [-.75, -.25]]) {
    const source = image.data({width: 2, height: 1, channels: 1, data: values});
    for (const filter of ['linear', 'trilinear', 'anisotropic']) {
      for (const address of ['clamp', 'repeat', 'zero']) {
        const field = scalar.image(source, {address, filter});
        const plan = compileGraph(surface.bump(surface.material(color.linear([.2, .3, .4])), field));
        const reader = plan.nodes.find(node => node.kind === 'imageScalar');
        assert.deepEqual(plan.ranges[reader.id], address === 'zero'
          ? [Math.min(0, ...values), Math.max(0, ...values)] : values);
      }
    }
  }
});

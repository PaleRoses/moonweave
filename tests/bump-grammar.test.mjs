import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scalar, color, surface, named, materialGraph, patchGraph, compileGraph,
  serializeGraph, parseGraph, foldGraph,
} from '../src/core.mjs';

test('bump is a typed surface operation with a scalar height and unchanged graph-v1 round trips', () => {
  const skin = surface.material(color.srgb('#9ab4bd'));
  const height = named('height', scalar.multiply(scalar.axis('x'), scalar.parameter(.05)));
  const graph = materialGraph(surface.bump(skin, height));
  assert.equal(graph.nodes.at(-1).kind, 'bump');
  assert.equal(graph.nodes.at(-1).height, 'height');
  assert.equal(serializeGraph(parseGraph(serializeGraph(graph))), serializeGraph(graph));
  assert.throws(() => materialGraph(surface.bump(skin, color.srgb('#000000'))), /expects scalar/);
  assert.throws(() => materialGraph(surface.bump(height, scalar.parameter(.2))), /expects surface/);
  assert.throws(() => patchGraph(graph, {[graph.output]: {height: 'other'}}), /structural/);
});

test('spatially uniform heights disappear independently of editable values', () => {
  const skin = surface.paint('carapace'), baseline = compileGraph(skin);
  for (const height of [
    0, 5, scalar.parameter(0), scalar.parameter(5),
    scalar.ramp(scalar.multiply(scalar.add(scalar.parameter(.3), .2), scalar.parameter(4)), 0, 3),
  ]) {
    const plan = compileGraph(surface.bump(skin, height));
    assert.equal(plan.programKey, baseline.programKey);
    assert.deepEqual(plan.cost, baseline.cost);
  }
  const shared = named('height', scalar.parameter(.2));
  const graph = materialGraph(surface.channels(surface.bump(skin, shared), {roughness: shared}));
  const first = compileGraph(graph), next = compileGraph(patchGraph(graph, {height: {value: .7}}));
  assert.equal(first.nodes.some(node => node.kind === 'bump'), false);
  assert.equal(first.nodes.filter(node => node.kind === 'parameter').length, 1);
  assert.equal(first.structure, next.structure);
  assert.equal(next.nodes.find(node => node.kind === 'parameter').value, .7);
});

test('varying heights stay live at zero amplitude and preserve shared field work', () => {
  const grain = named('grain', scalar.noise({seed: 5}));
  const gain = named('gain', scalar.parameter(0));
  const height = scalar.multiply(grain, gain);
  const skin = surface.channels(surface.material(color.mix(color.srgb('#204050'), color.srgb('#b8d0ce'), grain)), {roughness: grain});
  const graph = materialGraph(surface.bump(skin, height));
  const first = compileGraph(graph), changed = compileGraph(patchGraph(graph, {gain: {value: .1}}));
  assert.equal(first.nodes.filter(node => node.kind === 'bump').length, 1);
  assert.equal(first.cost.proceduralSamples, 1);
  assert.equal(first.structure, changed.structure);
  assert.equal(first.programKey, changed.programKey);
  const zeroHeight = compileGraph(surface.bump(skin, scalar.multiply(0, grain)));
  assert.equal(zeroHeight.programKey, compileGraph(skin).programKey);
});

test('a separate interpretation can read height and base surface through typed bump ports', () => {
  const graph = materialGraph(surface.bump(surface.material(color.linear([.2, .3, .4])), scalar.parameter(.7)));
  const result = foldGraph(graph, {
    color: node => node.value,
    material: node => ({color: node.color}),
    parameter: node => node.value,
    bump: node => ({...node.input, height: node.height}),
  });
  assert.deepEqual(result, {color: [.2, .3, .4], height: .7});
});

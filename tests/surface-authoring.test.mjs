import test from 'node:test';
import assert from 'node:assert/strict';
import {color, compileGraph, materialGraph, named, patchGraph, scalar, serializeGraph, surface} from '../src/core.mjs';
import {changePaintField, composeSurface, graphIndex, separatePaintField, sourcesFor} from '../lab/composition.mts';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';
import {addSurfaceDetail, connectDetailHeight, connectSurfaceFinish, exposeFinishValue, isHeightAmplitude, removeSurfaceDetail, surfaceFinish} from '../lab/surface-authoring.mts';

test('height applications share existing fields and retain independent signed amplitude bindings', () => {
  const original = COMPOSITION_EXAMPLES.stone.create();
  const detail = addSurfaceDetail(original, 'stoneGrain');
  const index = graphIndex(detail), output = index.byId.get(detail.output), height = index.byId.get(output.height);
  assert.equal(output.kind, 'bump');
  assert.equal(output.input, original.output);
  assert.equal(height.kind, 'multiply');
  assert.equal(height.b, 'stoneGrain');
  assert.equal(detail.nodes.filter(node => node.kind === 'noise').length, 1);
  assert.equal(compileGraph(detail).cost.paintSamples, 0);
  assert.equal(compileGraph(detail).cost.proceduralSamples, 1);
  assert.ok(isHeightAmplitude(detail, height.a));
  assert.equal(isHeightAmplitude(detail, 'stoneGrain'), false);
  const plan = compileGraph(detail), edited = patchGraph(detail, {[height.a]: {value: -.06}});
  assert.equal(compileGraph(edited).structure, plan.structure);
  assert.equal(graphIndex(edited).byId.get('stoneGrain'), index.byId.get('stoneGrain'));
  assert.deepEqual(index.byId.get('stoneGrain'), graphIndex(original).byId.get('stoneGrain'));
  assert.equal(graphIndex(original).byId.has(height.a), false);
});

test('replacing a complete height removes its abandoned scale but keeps other field users', () => {
  const original = COMPOSITION_EXAMPLES.stone.create(), detailed = addSurfaceDetail(original, 'stoneGrain');
  const oldIndex = graphIndex(detailed), oldHeight = oldIndex.byId.get(oldIndex.byId.get(detailed.output).height);
  const changed = connectDetailHeight(detailed, detailed.output, 'stoneTone'), next = graphIndex(changed);
  assert.equal(next.byId.get(changed.output).height, 'stoneTone');
  assert.equal(next.byId.has(oldHeight.id), false);
  assert.equal(next.byId.has(oldHeight.a), false);
  assert.ok(next.byId.has('stoneGrain'));
  assert.ok(next.byId.has('stoneTone'));
  assert.equal(connectDetailHeight(changed, changed.output, 'stoneTone'), changed);
  assert.equal(serializeGraph(removeSurfaceDetail(changed, changed.output)), serializeGraph(original));
});

test('removing a middle height application preserves shared grain and pre-existing unused definitions', () => {
  const base = materialGraph(surface.material(color.srgb('#aabbcc')));
  const original = materialGraph({...base, nodes: [...base.nodes, {id: 'reserved', kind: 'parameter', value: .3}]});
  const first = addSurfaceDetail(original), grain = first.nodes.find(node => node.kind === 'noise').id;
  const second = addSurfaceDetail(first, grain), firstHeight = graphIndex(first).byId.get(first.output).height;
  const removed = removeSurfaceDetail(second, first.output), index = graphIndex(removed);
  assert.equal(removed.output, second.output);
  assert.equal(index.byId.get(removed.output).input, original.output);
  assert.equal(index.byId.has(firstHeight), false);
  assert.ok(index.byId.has(grain));
  assert.ok(index.byId.has('reserved'));
  assert.equal(serializeGraph(removeSurfaceDetail(removed, removed.output)), serializeGraph(original));
});

test('finish field overrides are independent of height and reveal the original finish when removed', () => {
  const original = COMPOSITION_EXAMPLES.porcelain.create();
  const originalHeight = graphIndex(original).byId.get(original.output).height;
  const changed = connectSurfaceFinish(original, 'roughness', 'porcelainGrain');
  const both = connectSurfaceFinish(changed, 'clearcoat', 'porcelainGrain');
  assert.deepEqual(surfaceFinish(both).values, {roughness: 'porcelainGrain', clearcoat: 'porcelainGrain'});
  const one = connectSurfaceFinish(both, 'roughness');
  assert.deepEqual(surfaceFinish(one).values, {clearcoat: 'porcelainGrain'});
  const none = connectSurfaceFinish(one, 'clearcoat'), index = graphIndex(none);
  assert.equal(surfaceFinish(none), undefined);
  assert.equal(index.byId.get(none.output).height, originalHeight);
  assert.equal(index.byId.get(none.output).input, 'porcelainMaterial');
  assert.ok(index.byId.has('porcelainGrain'), 'Pigment and height retain their shared source.');
  assert.equal(connectSurfaceFinish(none, 'clearcoat'), none);
});

test('exposed finish values preserve literals and can become independent from a shared parameter', () => {
  const original = materialGraph(surface.channels(surface.material(color.srgb('#123456')), {roughness: .63}));
  const first = exposeFinishValue(original, 'roughness'), firstId = surfaceFinish(first).values.roughness;
  assert.equal(graphIndex(first).byId.get(firstId).kind, 'parameter');
  assert.equal(graphIndex(first).byId.get(firstId).value, .63);
  const shared = connectSurfaceFinish(first, 'clearcoat', firstId);
  const independent = exposeFinishValue(shared, 'roughness'), nextId = surfaceFinish(independent).values.roughness;
  assert.notEqual(firstId, nextId);
  const changed = patchGraph(independent, {[nextId]: {value: .4}}), index = graphIndex(changed);
  assert.equal(index.byId.get(firstId).value, .63);
  assert.equal(index.byId.get(nextId).value, .4);
  assert.equal(surfaceFinish(changed).values.clearcoat, firstId);
});

test('typed source selection excludes dependent expressions and structural edits reject wrong sorts', () => {
  const a = named('a', scalar.parameter(.2)), b = named('b', scalar.multiply(a, 2));
  const c = named('c', scalar.add(b, 1)), ink = named('ink', color.srgb('#abcdef'));
  const graph = materialGraph(surface.channels(surface.material(ink), {roughness: c}));
  const eligible = sourcesFor(graph, 'b', 'scalar').map(node => node.id);
  assert.ok(eligible.includes('a'));
  assert.equal(eligible.includes('b'), false);
  assert.equal(eligible.includes('c'), false);
  assert.equal(eligible.includes('ink'), false);
  const detailed = addSurfaceDetail(graph, 'b'), before = serializeGraph(detailed);
  assert.throws(() => connectDetailHeight(detailed, detailed.output, 'ink'), /expects scalar/);
  assert.throws(() => connectSurfaceFinish(detailed, 'roughness', 'ink'), /expects scalar/);
  assert.equal(serializeGraph(detailed), before);
});

test('reconnecting a painted field prunes its newly orphaned mapping and retains unused imports', () => {
  const original = composeSurface({accent: 'horn'}), separated = separatePaintField(original, 'accentPaint');
  const field = graphIndex(separated).byId.get('accentPaint').field;
  const imported = materialGraph({...separated, nodes: [...separated.nodes, {id: 'reserved', kind: 'parameter', value: .8}]});
  const shared = changePaintField(imported, 'accentPaint', 'baseField'), index = graphIndex(shared);
  assert.equal(index.byId.has(field), false);
  assert.ok(index.byId.has('reserved'));
  assert.equal(compileGraph(shared).cost.paintSamples, 1);
});

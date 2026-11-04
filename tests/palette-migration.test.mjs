import test from 'node:test';
import assert from 'node:assert/strict';
import {color, surface, materialGraph, expressionGraph, parseGraph, serializeGraph,
  migrateSurfaceRecipe, normalizeSurfaceRecipe, splitRecipe, PALETTE_KEYS} from '../src/core.mjs';

const read = (graph, id) => graph.nodes.find(node => node.id === id);
const legacy = (extra = []) => ({version: 1, nodes: [
  {id: 'field', kind: 'facets'},
  {id: 'paint', kind: 'paint', field: 'field', style: {
    palette: {base: '#ABCDEF', shadow: '#123456', light: '#fedcba'}, roughness: .63,
  }}, ...extra,
], output: 'paint'});

test('v1 import replaces every style swatch with a required canonical color input', () => {
  const source = legacy(), before = structuredClone(source), graph = materialGraph(source);
  assert.equal(graph.version, 2);
  assert.deepEqual(source, before);
  const paint = read(graph, 'paint');
  assert.equal(paint.field, 'field');
  assert.equal(paint.style.roughness, .63);
  assert.equal(Object.hasOwn(paint.style, 'palette'), false);
  for (const role of PALETTE_KEYS) assert.deepEqual(read(graph, paint.palette[role]).value,
    color.srgb(before.nodes[1].style.palette[role]).value);
  assert.equal(serializeGraph(parseGraph(serializeGraph(graph))), serializeGraph(graph));
});

test('legacy explicit field connections survive migration and generated IDs cannot collide', () => {
  const source = legacy([{id: 'legacyColor0', kind: 'color', value: [.2, .4, .6]}]);
  source.nodes[1].palette = {base: 'legacyColor0'};
  const graph = materialGraph(source), paint = read(graph, 'paint');
  assert.equal(paint.palette.base, 'legacyColor0');
  assert.deepEqual(read(graph, 'legacyColor0').value, [.2, .4, .6]);
  assert.equal(new Set(graph.nodes.map(node => node.id)).size, graph.nodes.length);
  assert.equal(read(graph, paint.palette.shadow).kind, 'color');
  assert.equal(read(graph, paint.palette.light).kind, 'color');
});

test('v2 has no missing-role or style-palette rendering path', () => {
  const graph = materialGraph(surface.paint());
  assert.equal(graph.version, 2);
  assert.deepEqual(Object.keys(read(graph, graph.output).palette), PALETTE_KEYS);
  const missing = structuredClone(graph);
  delete read(missing, missing.output).palette.shadow;
  assert.throws(() => materialGraph(missing), /palette.shadow is required/);
  const oldStyle = structuredClone(graph);
  read(oldStyle, oldStyle.output).style.palette = {base: '#123456'};
  assert.throws(() => materialGraph(oldStyle), /Unknown paint style property: palette/);
});

test('legacy flat recipes have one explicit migration boundary', () => {
  const source = {version: 1, scale: .3, rotation: -10, roughness: .7, palette: {base: '#123456'}};
  const next = migrateSurfaceRecipe(source);
  assert.equal(next.version, 2);
  assert.equal(next.mapping.scale, .3);
  assert.equal(next.mapping.rotation, 350);
  assert.equal(next.style.roughness, .7);
  assert.deepEqual(next.palette.base.value, color.srgb('#123456').value);
  assert.deepEqual(next.palette.shadow, splitRecipe().palette.shadow);
  assert.equal(normalizeSurfaceRecipe(next), next);
  assert.throws(() => normalizeSurfaceRecipe(source), /Unknown recipe/);
  assert.throws(() => migrateSurfaceRecipe({...source, typo: true}), /Unknown legacy recipe/);
  assert.throws(() => migrateSurfaceRecipe({...source, version: 7}), /Unsupported/);
});

test('equal legacy swatches remain independently editable source nodes', () => {
  const source = legacy();
  source.nodes.push({...source.nodes[1], id: 'other'});
  source.nodes.push({id: 'mix', kind: 'mix', a: 'paint', b: 'other', mask: 'amount'},
    {id: 'amount', kind: 'parameter', value: .5});
  source.output = 'mix';
  const graph = materialGraph(source);
  for (const role of PALETTE_KEYS) {
    const a = read(graph, 'paint').palette[role], b = read(graph, 'other').palette[role];
    assert.notEqual(a, b);
    assert.deepEqual(read(graph, a).value, read(graph, b).value);
  }
});

test('v1 scalar and color documents import without adding material structure', () => {
  const graph = expressionGraph({version: 1, nodes: [{id: 'color', kind: 'color', value: [.1, .2, .3]}], output: 'color'});
  assert.equal(graph.version, 2);
  assert.equal(graph.nodes.length, 1);
});

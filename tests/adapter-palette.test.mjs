import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {color, scalar, createFieldSampler} from '../src/core.mjs';
import {createPaintTextures, createTexturingSystem} from '../src/three.mjs';

function fixture() {
  const fields = createPaintTextures(THREE, {
    topData: new Uint8Array(512 * 512 * 4), wallData: new Uint8Array(512 * 512 * 4),
  });
  const system = createTexturingSystem(THREE, {fields});
  return {system, dispose() {system.dispose(); fields.dispose();}};
}
const paint = handle => handle.graph.nodes.find(node => node.kind === 'paint');
const paletteValue = (handle, role, context) => createFieldSampler(handle.graph, {
  color: {id: paint(handle).palette[role], sort: 'color'},
})(context).color.value;

test('recipe literal palette edits keep live topology while patching canonical color nodes', () => {
  const f = fixture();
  try {
    const handle = f.system.createMaterial('carapace'), plan = handle.plan;
    const ids = {...paint(handle).palette};
    handle.update({palette: {base: color.linear([.2, .3, .4])}, style: {roughness: .6}});
    assert.equal(handle.plan.structure, plan.structure);
    assert.deepEqual(paint(handle).palette, ids);
    assert.deepEqual(paletteValue(handle, 'base'), [.2, .3, .4]);
    assert.equal(paint(handle).style.roughness, .6);
    assert.equal(Object.hasOwn(paint(handle).style, 'palette'), false);
  } finally {f.dispose();}
});

test('structural palette updates preserve field and paint names and keep color sharing explicit', () => {
  const f = fixture();
  try {
    const shared = color.linear([.2, .3, .4]);
    const handle = f.system.createMaterial({palette: {base: shared, shadow: shared}});
    const original = paint(handle), oldKey = handle.plan.programKey;
    const field = color.mix(shared, color.linear([.8, .7, .6]), scalar.axis('x'));
    handle.update({palette: {base: field}});
    assert.equal(paint(handle).id, original.id);
    assert.equal(paint(handle).field, original.field);
    assert.notEqual(handle.plan.programKey, oldKey);
    assert.deepEqual(paletteValue(handle, 'shadow'), [.2, .3, .4]);
    assert.deepEqual(paletteValue(handle, 'base', {position: [1, 0, 0]}), [.8, .7, .6]);
    const structure = handle.plan.structure;
    handle.update({mapping: {scale: .3}});
    assert.equal(handle.plan.structure, structure);
  } finally {f.dispose();}
});

test('changing one role of a shared literal palette does not recolor its siblings', () => {
  const f = fixture();
  try {
    const shared = color.linear([.2, .3, .4]);
    const handle = f.system.createMaterial({palette: {base: shared, shadow: shared}});
    const original = paint(handle);
    assert.equal(original.palette.base, original.palette.shadow);
    handle.update({palette: {base: color.linear([.8, .7, .6])}});
    assert.notEqual(paint(handle).palette.base, paint(handle).palette.shadow);
    assert.deepEqual(paletteValue(handle, 'base'), [.8, .7, .6]);
    assert.deepEqual(paletteValue(handle, 'shadow'), [.2, .3, .4]);
  } finally {f.dispose();}
});

test('equal-valued palette replacements retain author identity for later shared composition', () => {
  const f = fixture();
  try {
    const original = color.linear([.2, .3, .4]);
    const handle = f.system.createMaterial({palette: {base: original}});
    const graph = handle.graph, plan = handle.plan;
    const shared = color.linear([.2, .3, .4]);
    handle.update({palette: {base: shared}});
    assert.equal(handle.graph, graph);
    assert.equal(handle.plan, plan);
    assert.equal(handle.recipe.palette.base, shared);
    handle.update({palette: {shadow: shared}});
    assert.equal(handle.recipe.palette.base, handle.recipe.palette.shadow);
    assert.equal(paint(handle).palette.base, paint(handle).palette.shadow);
  } finally {f.dispose();}
});

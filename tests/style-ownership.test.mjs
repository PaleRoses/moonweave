import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.mjs';
import {patchPaintStyle, normalizePaintPalette} from '../src/core/recipe.mts';
import {isOwned} from '../src/core/ownership.mts';

const {
  normalizePaintStyle, normalizeSurfaceRecipe, patchSurfaceRecipe, splitRecipe,
  facets, surface, scalar, color, domain, inDomain, expressionGraph, materialGraph, patchGraph, compileGraph,
} = core;
const paintIn = graph => graph.nodes.find(node => node.kind === 'paint');
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('only owned normalized values are borrowed; caller style and palette data stay detached and mutable', () => {
  const raw = {style: {roughness: .4}, palette: {base: {kind: 'color', value: [.1, .2, .3]}}};
  const recipe = normalizeSurfaceRecipe(raw), {style, palette} = recipe;
  assert.equal(isOwned(raw), false);
  assert.equal(isOwned(recipe), true);
  assert.equal(isOwned(style), true);
  assert.equal(isOwned(palette.base), true);
  assert.equal(normalizePaintStyle(style), style);
  assert.equal(normalizeSurfaceRecipe(recipe), recipe);
  assert.ok(Object.isFrozen(style));
  assert.ok(Object.isFrozen(palette.base.value));
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.isFrozen(raw.palette), false);
  raw.palette.base.value[0] = .9; raw.style.roughness = .9;
  assert.deepEqual(palette.base.value, [.1, .2, .3]);
  assert.equal(style.roughness, .4);

  const rawPalette = {base: {kind: 'color', value: [.3, .2, .1]}};
  const frozen = Object.freeze({palette: rawPalette, style: {roughness: .5}});
  assert.equal(isOwned(frozen), false);
  const decoded = normalizeSurfaceRecipe(frozen);
  assert.notEqual(decoded, frozen);
  assert.notEqual(decoded.palette, rawPalette);
  rawPalette.base.value[0] = .8;
  assert.deepEqual(decoded.palette.base.value, [.3, .2, .1]);
  assert.equal(Object.isFrozen(rawPalette), false);
  assert.throws(() => normalizePaintStyle(Object.freeze({roughness: NaN})), /roughness/);
  assert.throws(() => normalizePaintPalette(Object.freeze({base: 'red'})), /palette.base/);
  assert.throws(() => normalizePaintStyle({palette: {base: '#abcdef'}}), /Unknown paint style property: palette/);
});

test('trusted style identity survives paint construction, graph normalization and domain binding', () => {
  const style = normalizePaintStyle({roughness: .6}), field = facets();
  const expression = surface.paint(field, style), graph = materialGraph(expression);
  assert.equal(expression.style, style);
  assert.equal(paintIn(graph).style, style);
  assert.equal(paintIn(compileGraph(graph)).style, style);
  assert.equal(paintIn(materialGraph(inDomain(expression, domain.transform(identity)))).style, style);
  const recipe = normalizeSurfaceRecipe('horn'), fromRecipe = surface.paint(recipe);
  assert.equal(fromRecipe.style, splitRecipe(recipe).style);
  assert.equal(paintIn(materialGraph(fromRecipe)).style, splitRecipe(recipe).style);
});

test('numeric style edits preserve canonical palette identity and do not mutate the previous value', () => {
  const recipe = normalizeSurfaceRecipe('carapace'), {style} = recipe;
  const next = patchPaintStyle(style, {roughness: .3});
  assert.notEqual(next, style);
  assert.equal(next.roughness, .3);
  assert.equal(style.roughness, .55);
  assert.equal(normalizePaintStyle(next), next);
  assert.ok(Object.isFrozen(next));
  assert.deepEqual({...next, roughness: style.roughness}, style);
  assert.equal(Object.hasOwn(next, 'palette'), false);
  const edited = patchSurfaceRecipe(recipe, {style: {roughness: .3}});
  assert.equal(edited.palette, recipe.palette);
  assert.equal(edited.mapping, recipe.mapping);
  const trustedPatch = normalizePaintStyle({...style, roughness: .2});
  assert.equal(patchPaintStyle(style, trustedPatch).roughness, .2);
});

test('palette edits snapshot changed raw colors, borrow owned roots and preserve unchanged recipe parts', () => {
  const recipe = normalizeSurfaceRecipe('horn');
  const patch = {palette: {base: {kind: 'color', value: [.1, .2, .3]}}};
  const next = patchSurfaceRecipe(recipe, patch);
  assert.notEqual(next.palette, recipe.palette);
  assert.deepEqual(next.palette.base.value, [.1, .2, .3]);
  assert.equal(next.palette.shadow, recipe.palette.shadow);
  assert.equal(next.style, recipe.style);
  assert.equal(next.mapping, recipe.mapping);
  assert.ok(Object.isFrozen(next.palette));
  assert.ok(Object.isFrozen(next.palette.base.value));
  assert.equal(Object.isFrozen(patch), false);
  assert.equal(Object.isFrozen(patch.palette), false);
  patch.palette.base.value[0] = .9;
  assert.equal(next.palette.base.value[0], .1);
  assert.equal(patchSurfaceRecipe(recipe, {palette: next.palette}).palette, next.palette,
    'A complete trusted palette can be borrowed directly.');
  const ink = color.srgb('#abcdef');
  const owned = patchSurfaceRecipe(recipe, {palette: {base: ink, light: ink}});
  assert.equal(owned.palette.base, ink);
  assert.equal(owned.palette.light, ink);
  const raw = {kind: 'color', value: [.4, .3, .2]};
  const shared = normalizeSurfaceRecipe({palette: {base: raw, light: raw}});
  assert.equal(shared.palette.base, shared.palette.light);
  assert.notEqual(shared.palette.base, raw);
});

test('empty, identical and normalized no-op style edits preserve style, graph and plan identity', () => {
  const graph = materialGraph(surface.paint('horn')), paint = paintIn(graph), style = paint.style;
  const plan = compileGraph(graph);
  for (const patch of [{}, {roughness: style.roughness}, style, normalizePaintStyle({...style})]) {
    assert.equal(patchPaintStyle(style, patch), style);
    const next = patchGraph(graph, {[paint.id]: {style: patch}});
    assert.equal(next, graph);
    assert.equal(compileGraph(next), plan);
  }
});

test('invalid style patches fail atomically even after another valid node edit', () => {
  const graph = materialGraph(surface.channels(surface.paint('horn'), {metalness: scalar.parameter(.1)}));
  const paint = paintIn(graph), parameter = graph.nodes.find(node => node.kind === 'parameter');
  const before = JSON.stringify(graph), plan = compileGraph(graph);
  const invalid = [null, [], {roughness: undefined}, {roughness: NaN}, {roughness: 2},
    {scale: .2}, {palette: null}, {palette: {base: 'red'}}, {palette: {extra: '#123456'}}];
  for (const patch of invalid) {
    assert.throws(() => patchPaintStyle(paint.style, patch));
    assert.throws(() => patchGraph(graph, {[parameter.id]: {value: .9}, [paint.id]: {style: patch}}));
    assert.equal(JSON.stringify(graph), before);
    assert.equal(compileGraph(graph), plan);
  }
});

test('paint nodes sharing a style retain independently editable shader bindings', () => {
  const style = normalizePaintStyle('horn'), field = facets();
  const graph = materialGraph(surface.mix(surface.paint(field, style), surface.paint(field, style), scalar.parameter(.5)));
  const paints = graph.nodes.filter(node => node.kind === 'paint'), plan = compileGraph(graph);
  assert.equal(paints.length, 2);
  assert.notEqual(paints[0], paints[1]);
  assert.equal(paints[0].style, style);
  assert.equal(paints[1].style, style);
  assert.equal(plan.nodes.filter(node => node.kind === 'paint').length, 2);
  const next = patchGraph(graph, {[paints[0].id]: {style: {roughness: .2}}});
  const changed = next.nodes.find(node => node.id === paints[0].id);
  assert.equal(changed.style.roughness, .2);
  assert.equal(changed.palette, paints[0].palette);
  assert.equal(next.nodes.find(node => node.id === paints[1].id), paints[1]);
  assert.equal(paints[1].style.roughness, .64);
  assert.equal(compileGraph(next).structure, plan.structure);
});

test('canonical recipe edits share untouched parts and normalized no-ops preserve recipe identity', () => {
  const recipe = normalizeSurfaceRecipe('carapace'), parts = splitRecipe(recipe);
  const appearance = patchSurfaceRecipe(recipe, {style: {roughness: .2}}), appearanceParts = splitRecipe(appearance);
  assert.equal(appearanceParts.mapping, parts.mapping);
  assert.equal(appearance.mapping.stretch, recipe.mapping.stretch);
  assert.equal(appearance.palette, recipe.palette);
  assert.equal(appearanceParts.style.roughness, .2);
  const mapping = patchSurfaceRecipe(recipe, {mapping: {scale: .3}});
  assert.equal(splitRecipe(mapping).style, parts.style);
  assert.equal(mapping.palette, recipe.palette);
  for (const patch of [{}, recipe, {version: 2}, {style: {roughness: recipe.style.roughness}},
    {mapping: {rotation: recipe.mapping.rotation + 360}}, {mapping: {stretch: [...recipe.mapping.stretch]}},
    {palette: {}}, {palette: {base: recipe.palette.base}}]) {
    assert.equal(patchSurfaceRecipe(recipe, patch), recipe);
  }
  const before = JSON.stringify(recipe);
  for (const patch of [{version: 1}, {mapping: {scale: 0}}, {palette: {base: 'red'}}, {style: {roughness: .2, extra: true}}]) {
    assert.throws(() => patchSurfaceRecipe(recipe, patch));
    assert.equal(JSON.stringify(recipe), before);
  }
});

test('value-only graph edits preserve list ports and still validate values against their arity', () => {
  const graph = expressionGraph(color.ramp(scalar.parameter(.4), [
    [0, color.linear([.1, .2, .3])], [1, color.linear([.5, .6, .7])],
  ]));
  const ramp = graph.nodes.find(node => node.kind === 'colorRamp');
  const positions = [0, 2], changed = patchGraph(graph, {[ramp.id]: {positions}});
  const updated = changed.nodes.find(node => node.id === ramp.id);
  assert.equal(updated.colors, ramp.colors);
  assert.notEqual(updated.positions, positions);
  assert.deepEqual(updated.positions, [0, 2]);
  assert.deepEqual(ramp.positions, [0, 1]);
  positions[1] = 4;
  assert.deepEqual(updated.positions, [0, 2]);
  assert.throws(() => patchGraph(graph, {[ramp.id]: {positions: [0, 1, 2]}}), /match its color stops/);
  assert.throws(() => patchGraph(graph, {[ramp.id]: {colors: [...ramp.colors].reverse()}}), /Unknown/);
  assert.equal(patchGraph(changed, {[ramp.id]: {positions: [0, 2]}}), changed);
});

test('ownership helpers remain internal', () => {
  for (const key of ['isOwned', 'ownValue', 'ownFrozen', 'patchPaintStyle']) assert.equal(Object.hasOwn(core, key), false);
});

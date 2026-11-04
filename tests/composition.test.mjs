import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeSurface, paintsIn, parseSurface, graphIndex, maskInfo, appendPaint,
  removeBlend, separatePaintField, changePaintField, replaceBlendMask, reverseBlendMask,
  editLiteral,
} from '../lab/composition.mts';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';
import {createFrameBatch, mergeGraphChanges, readValueChanges} from '../lab/frame-batch.mts';
import {materialGraph, surface, scalar, domain, named, splitRecipe, serializeGraph, compileGraph, patchGraph, evaluateScalar} from '../src/core.mjs';
import {SURFACE_PRESETS} from '../src/core/recipe.mts';

for (const [name, create] of [['single paint', () => composeSurface()], ...Object.entries(COMPOSITION_EXAMPLES).map(([name, example]) => [name, example.create])]) {
  test(`atelier ${name}: template and JSON round-trip exactly`, () => {
    const graph = create(), before = serializeGraph(graph);
    assert.equal(serializeGraph(parseSurface(before)), before);
    assert.equal(serializeGraph(graph), before);
    assert.ok(Object.isFrozen(graph));
  });
}

test('an arbitrary imported composition survives editing one paint with its IDs and references intact', () => {
  const frame = domain.transform([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1]);
  const graph = materialGraph(surface.channels(surface.relief(surface.mix(
    surface.paint('horn', {domain: frame}), surface.paint('carapace'),
    scalar.ramp(scalar.axis('z', frame), -.3, .9),
  ), scalar.parameter(.7)), {roughness: scalar.ramp(scalar.facing([0, 1, 0]), -.3, .9)}));
  const original = serializeGraph(graph), paint = paintsIn(graph)[0];
  const next = patchGraph(graph, {[paint.id]: {style: {marks: .27}}});
  assert.equal(next.output, graph.output);
  assert.equal(next.nodes.length, graph.nodes.length);
  for (let i = 0; i < graph.nodes.length; i++) if (graph.nodes[i].id !== paint.id) assert.equal(next.nodes[i], graph.nodes[i]);
  assert.equal(graphIndex(next).byId.get(paint.id).style.marks, .27);
  assert.equal(compileGraph(next).structure, compileGraph(graph).structure);
  assert.equal(serializeGraph(graph), original);
});

test('shared mapping edits retain one sample; making a mapping independent changes only its reference', () => {
  const graph = COMPOSITION_EXAMPLES.belly.create();
  const edited = patchGraph(graph, {baseField: {scale: .31, rotation: 41}});
  const paints = graphIndex(edited).paints;
  assert.equal(paints[0].field, paints[1].field);
  for (const paint of paintsIn(edited)) { assert.equal(paint.mapping.scale, .31); assert.equal(paint.mapping.rotation, 41); }
  assert.equal(compileGraph(edited).cost.textureReads, 4);
  const separate = separatePaintField(edited, 'accentPaint');
  const separateEdit = patchGraph(separate, {[graphIndex(separate).byId.get('accentPaint').field]: {scale: .21}});
  assert.equal(paintsIn(separateEdit)[0].mapping.scale, .31);
  assert.equal(paintsIn(separateEdit)[1].mapping.scale, .21);
  assert.equal(compileGraph(separateEdit).cost.textureReads, 8);
  assert.equal(separatePaintField(separateEdit, 'accentPaint'), separateEdit, 'Already independent mappings do not gain redundant samples.');
  const sharedAgain = changePaintField(separateEdit, 'accentPaint', 'baseField');
  assert.equal(compileGraph(sharedAgain).cost.textureReads, 4);
});

test('mask inspection and paint edits never convert a literal into a parameter', () => {
  const graph = materialGraph(surface.mix(surface.paint('horn'), surface.paint('carapace'), 0));
  const info = maskInfo(graph, graph.output), paint = paintsIn(graph)[0];
  assert.equal(info.mode, 'uniform'); assert.equal(info.strength.kind, 'constant');
  assert.equal(compileGraph(graph).cost.textureReads, 4);
  const next = patchGraph(graph, {[paint.id]: {style: {marks: .27}}});
  assert.equal(graphIndex(next).byId.get(info.strength.id).kind, 'constant');
  assert.equal(compileGraph(next).cost.textureReads, 4);
  const changed = editLiteral(next, info.strength.id, 1);
  assert.equal(graphIndex(changed).byId.get(info.strength.id).kind, 'constant');
  assert.equal(graphIndex(changed).byId.get(info.strength.id).value, 1);
});

test('independent parameters in a product stay independent and keep their program structure', () => {
  const graph = materialGraph(surface.mix(surface.paint('horn'), surface.paint('carapace'), scalar.multiply(scalar.parameter(.5), scalar.parameter(.6))));
  const info = maskInfo(graph, graph.output), parameters = info.controls.filter(node => node.kind === 'parameter');
  assert.equal(info.mode, 'custom'); assert.equal(parameters.length, 2);
  for (const value of [0, .7, 1]) {
    const next = patchGraph(graph, {[parameters[0].id]: {value}});
    assert.equal(graphIndex(next).byId.get(parameters[1].id).value, .6);
    assert.deepEqual(graphIndex(next).byId.get(info.blend.mask), graphIndex(graph).byId.get(info.blend.mask));
    assert.equal(compileGraph(next).structure, compileGraph(graph).structure);
  }
});

test('a mix of the same paint remains a valid single paint definition', () => {
  const paint = surface.paint('horn'), graph = materialGraph(surface.mix(paint, paint, scalar.parameter(.5)));
  assert.equal(paintsIn(graph).length, 1);
  const info = maskInfo(graph, graph.output);
  assert.equal(info.blend.a, info.blend.b);
  assert.equal(info.controls.length, 1);
  assert.equal(compileGraph(graph).cost.textureReads, 4);
  const next = patchGraph(graph, {[info.strength.id]: {value: .8}});
  assert.equal(paintsIn(next).length, 1);
  assert.equal(graphIndex(next).byId.get(next.output).a, graphIndex(next).byId.get(next.output).b);
});

test('three and four paints append without rewriting prior compositions', () => {
  let graph = composeSurface();
  for (let count = 2; count <= 4; count++) {
    const before = graph, added = appendPaint(before, {field: 'baseField'}); graph = added.graph;
    assert.equal(paintsIn(graph).length, count);
    assert.equal(graphIndex(graph).byId.get(added.blendId).a, before.output);
    for (const node of before.nodes) assert.deepEqual(graphIndex(graph).byId.get(node.id), node);
    assert.equal(compileGraph(graph).cost.textureReads, 4);
  }
});

test('removing a middle blend bypasses its first input and prunes only newly orphaned live work', () => {
  const start = composeSurface();
  const withSpare = materialGraph({...start, nodes: [...start.nodes, {id: 'savedParameter', kind: 'parameter', value: .2}]});
  const first = appendPaint(withSpare, {field: 'baseField'});
  const middle = appendPaint(first.graph);
  const last = appendPaint(middle.graph, {field: 'baseField'});
  const before = serializeGraph(last.graph), removed = removeBlend(last.graph, middle.blendId), index = graphIndex(removed);
  assert.equal(removed.output, last.blendId);
  assert.equal(index.byId.get(last.blendId).a, first.blendId);
  assert.equal(index.byId.has(middle.blendId), false);
  assert.equal(index.byId.has(middle.paintId), false);
  assert.equal(index.byId.get('savedParameter').value, .2);
  assert.equal(index.fields.length, 1, 'The removed paint’s private field is newly orphaned.');
  assert.equal(serializeGraph(last.graph), before);
});

test('editing one selected region preserves other blends and shared mask values', () => {
  const base = COMPOSITION_EXAMPLES.belly.create(), added = appendPaint(base, {field: 'baseField'});
  const beforeOuter = graphIndex(added.graph).byId.get(added.blendId);
  const changed = replaceBlendMask(added.graph, 'surface', 'height');
  assert.deepEqual(graphIndex(changed).byId.get(added.blendId), beforeOuter);
  assert.equal(graphIndex(changed).byId.get('amount').kind, 'parameter');
  assert.equal(graphIndex(changed).byId.get('amount').value, .94);
  const twice = reverseBlendMask(reverseBlendMask(changed, 'surface'), 'surface');
  assert.equal(serializeGraph(twice), serializeGraph(changed));
});

test('changing a reversed region preserves its strength, boundary and both complement positions', () => {
  for (const amount of [0, .2, .94, 1]) {
    const graph = reverseBlendMask(patchGraph(COMPOSITION_EXAMPLES.belly.create(), {amount: {value: amount}}), 'surface');
    const before = maskInfo(graph, 'surface');
    assert.equal(before.mode, 'facing');
    assert.equal(before.strength.id, 'amount');
    const changed = replaceBlendMask(graph, 'surface', 'height'), info = maskInfo(changed, 'surface');
    assert.equal(info.mode, 'height');
    assert.equal(info.strength.id, 'amount');
    assert.equal(info.strength.value, amount);
    assert.equal(info.region.low, before.region.low);
    assert.equal(info.region.high, before.region.high);
    assert.deepEqual(info.path.map(({node, edge}) => [node.kind, edge]), [
      ['complement', 'input'], ['multiply', 'a'], ['complement', 'input'], ['ramp', 'input'],
    ]);
    for (const [y, region] of [[-1, 0], [-.1, .5], [1, 1]]) {
      const value = evaluateScalar(changed, info.blend.mask, {position: [0, y, 0]}).value;
      assert.ok(Math.abs(value - (1 - amount * (1 - region))) < 1e-14);
    }
    assert.equal(replaceBlendMask(changed, 'surface', 'height'), changed, 'Selecting the current region is a no-op.');
  }
});

test('region replacement preserves literal IDs, local frames, product order and nested reversals', () => {
  const frame = named('localFrame', domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, .2, 0, 1]));
  const boundary = scalar.ramp(scalar.axis('y', frame), -.8, .2);
  const strength = named('__proto__', scalar.constant(1e-20));
  const mask = scalar.complement(scalar.complement(scalar.multiply(strength, scalar.complement(scalar.complement(boundary)))));
  const graph = materialGraph(surface.mix(surface.paint('horn'), surface.paint('carapace'), mask));
  const changed = replaceBlendMask(graph, graph.output, 'facing'), info = maskInfo(changed, changed.output);
  assert.equal(info.strength.id, '__proto__');
  assert.equal(info.strength.kind, 'constant');
  assert.equal(info.strength.value, 1e-20);
  assert.equal(info.coordinate.domain, 'localFrame');
  assert.equal(info.region.low, -.8); assert.equal(info.region.high, .2);
  assert.deepEqual(info.path.map(({node, edge}) => [node.kind, edge]), [
    ['complement', 'input'], ['complement', 'input'], ['multiply', 'b'],
    ['complement', 'input'], ['complement', 'input'], ['ramp', 'input'],
  ]);
  assert.equal(evaluateScalar(changed, info.blend.mask, {normal: [0, 1, 0]}).value, 0,
    '1 - (1 - 1e-20) rounds to zero; deleting the complements would change the result.');
});

test('changing one region copies its shared mask path without rewriting another blend', () => {
  const added = appendPaint(reverseBlendMask(COMPOSITION_EXAMPLES.belly.create(), 'surface'), {field: 'baseField'});
  const sharedMask = graphIndex(added.graph).byId.get('surface').mask;
  const graph = materialGraph({...added.graph, nodes: added.graph.nodes.map(node => node.id === added.blendId ? {...node, mask: sharedMask} : node)});
  const changed = replaceBlendMask(graph, 'surface', 'height'), next = graphIndex(changed);
  for (const node of graph.nodes) if (node.id !== 'surface') assert.deepEqual(next.byId.get(node.id), node);
  assert.equal(next.byId.get(added.blendId).mask, sharedMask);
  assert.notEqual(next.byId.get('surface').mask, sharedMask);
  assert.equal(maskInfo(changed, added.blendId).mode, 'facing');
  assert.equal(maskInfo(changed, 'surface').mode, 'height');
  assert.equal(maskInfo(changed, 'surface').strength.id, maskInfo(changed, added.blendId).strength.id);
  const context = {position: [0, .4, 0], normal: [0, -1, 0]};
  assert.equal(evaluateScalar(changed, sharedMask, context).value, evaluateScalar(graph, sharedMask, context).value);
});

test('uniform transitions retain full-mask reversal and remove only the regional part', () => {
  const reversed = reverseBlendMask(COMPOSITION_EXAMPLES.belly.create(), 'surface');
  const uniform = replaceBlendMask(reversed, 'surface', 'uniform'), amount = maskInfo(uniform, 'surface');
  assert.equal(amount.mode, 'uniform');
  assert.equal(amount.strength.id, 'amount');
  assert.deepEqual(amount.path.map(({node}) => node.kind), ['complement']);
  assert.equal(evaluateScalar(uniform, amount.blend.mask).value, 1 - .94);
  const positioned = replaceBlendMask(uniform, 'surface', 'height'), info = maskInfo(positioned, 'surface');
  assert.deepEqual(info.path.map(({node}) => node.kind), ['complement', 'multiply', 'ramp']);
  assert.equal(info.strength.value, .94);
  assert.equal(evaluateScalar(positioned, info.blend.mask, {position: [0, -1, 0]}).value, 1);
  assert.equal(evaluateScalar(positioned, info.blend.mask, {position: [0, 1, 0]}).value, 1 - .94);
});

test('imported regions without a strength keep their unit amplitude', () => {
  const graph = materialGraph(surface.mix(surface.paint('horn'), surface.paint('carapace'), scalar.complement(scalar.ramp(scalar.axis('y'), -.7, .9))));
  const changed = replaceBlendMask(graph, graph.output, 'facing'), info = maskInfo(changed, changed.output);
  assert.equal(info.strength, null);
  assert.equal(info.region.low, -.7); assert.equal(info.region.high, .9);
  assert.equal(info.controls.filter(node => node.kind === 'parameter').length, 0);
  const uniform = replaceBlendMask(changed, changed.output, 'uniform'), amount = maskInfo(uniform, uniform.output);
  assert.equal(amount.strength.value, 1);
  assert.equal(evaluateScalar(uniform, amount.blend.mask).value, 0);
});

test('wrapped independent parameters remain a custom expression without an inferred strength', () => {
  const expression = scalar.complement(scalar.multiply(scalar.parameter(.5), scalar.complement(scalar.parameter(.6))));
  const graph = materialGraph(surface.mix(surface.paint('horn'), surface.paint('carapace'), expression));
  const info = maskInfo(graph, graph.output);
  assert.equal(info.mode, 'custom'); assert.equal(info.strength, null);
  assert.equal(info.controls.filter(node => node.kind === 'parameter').length, 2);
  const replacement = replaceBlendMask(graph, graph.output, 'height'), replaced = maskInfo(replacement, replacement.output);
  assert.deepEqual(replaced.path.map(({node}) => node.kind), ['complement', 'multiply', 'ramp']);
});

test('frame batching coalesces independent edits, uses last values, and flushes before consumption', () => {
  let next = 1; const callbacks = new Map(), commits = [], scheduled = [];
  const batch = createFrameBatch(changes => { commits.push(changes); return true; }, {
    request(callback) { const id = next++; callbacks.set(id, callback); return id; },
    cancel(id) { callbacks.delete(id); }, scheduled() { scheduled.push('draw'); },
  });
  batch.queue({paint: {style: {roughness: .2}}, baseColor: {value: [.1, .2, .3]}});
  batch.queue({paint: {style: {roughness: .7}}, lightColor: {value: [.4, .5, .6]}, amount: {value: .9}});
  assert.equal(callbacks.size, 1); assert.equal(scheduled.length, 1); assert.equal(commits.length, 0);
  assert.equal(batch.value('amount', {kind: 'parameter', value: .5}).value, .9);
  batch.flush();
  assert.equal(callbacks.size, 0); assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], {paint: {style: {roughness: .7}}, baseColor: {value: [.1, .2, .3]}, lightColor: {value: [.4, .5, .6]}, amount: {value: .9}});
  batch.flush(); assert.equal(commits.length, 1);
  batch.queue({amount: {value: .1}}); batch.dispose(); assert.equal(callbacks.size, 0); assert.equal(commits.length, 1);
});

test('patch composition retains unchanged values and preserves opaque IDs and invalid keys for validation', () => {
  const previous = {paint: {style: {roughness: .2, opacity: 1}}, color: {value: [.1, .2, .3]}, direction: {direction: [0, 1, 0]}};
  assert.equal(mergeGraphChanges(previous, {paint: {style: {roughness: .2}}, color: {value: [.1, .2, .3]}, direction: {direction: [0, 1, 0]}}), previous);
  const next = mergeGraphChanges(previous, {paint: {style: {opacity: .8}}, color: {value: [.4, .5, .6]}});
  assert.equal(next.direction, previous.direction);
  assert.equal(next.paint.style.roughness, .2);
  assert.deepEqual(next.color.value, [.4, .5, .6]);
  assert.deepEqual(previous.color.value, [.1, .2, .3]);
  const invalid = mergeGraphChanges(previous, {paint: {style: {unknown: undefined}}});
  assert.equal(Object.hasOwn(invalid.paint.style, 'unknown'), true);
  assert.deepEqual(mergeGraphChanges(previous, {paint: {style: []}}).paint.style, []);
  const accepted = {style: {roughness: .3, opacity: 1}};
  assert.deepEqual(readValueChanges({style: {roughness: .3}}, accepted), {style: {roughness: .3}});
  const opaque = mergeGraphChanges({}, JSON.parse('{"__proto__":{"value":0.5}}'));
  assert.equal(Object.hasOwn(opaque, '__proto__'), true);
  assert.equal(opaque.__proto__.value, .5);
  assert.equal(Object.getPrototypeOf(opaque), Object.prototype);
});

test('pending control values support authored IDs that also name Object prototype properties', () => {
  const batch = createFrameBatch(() => {}, {request: () => 1, cancel() {}});
  const node = {kind: 'ramp', input: 'axis', low: -.5, high: .5};
  for (const id of ['constructor', 'toString', '__proto__']) {
    assert.equal(batch.value(id, node), node);
    batch.queue({[id]: {low: -.2}});
    assert.deepEqual(batch.value(id, node), {...node, low: -.2});
  }
  batch.dispose();
});

test('generic scalar controls exclude unused nodes and every kind already available in a blend mask', () => {
  const painted = surface.paint('carapace');
  const direction = named('direction', scalar.facing([0, 1, 0]));
  const boundary = named('boundary', scalar.ramp(direction, -1, 1));
  const gain = named('gain', scalar.constant(.7));
  const finished = surface.channels(surface.relief(painted, gain), {roughness: boundary, metalness: named('metalness', scalar.parameter(.2))});
  const composed = materialGraph(surface.mix(finished, painted, boundary));
  const graph = materialGraph({...composed, nodes: [...composed.nodes, {id: 'unused', kind: 'constant', value: .5}]});
  const index = graphIndex(graph);
  assert.deepEqual(new Set(index.surfaceControls.map(node => node.id)), new Set(['gain', 'metalness']));
  assert.deepEqual(maskInfo(graph, graph.output).controls.map(node => node.id), ['direction', 'boundary']);
  const changed = patchGraph(graph, {boundary: {low: -.5}, metalness: {value: .8}});
  assert.equal(graphIndex(changed).maskSlots, index.maskSlots);
  assert.equal(graphIndex(changed).surfaceControls.find(node => node.id === 'metalness').value, .8);
});

test('value revisions reuse structural inspection without retaining a previous graph', () => {
  const graph = COMPOSITION_EXAMPLES.belly.create(), before = graphIndex(graph);
  const next = patchGraph(graph, {amount: {value: .4}}), after = graphIndex(next);
  assert.equal(after.fieldUsers, before.fieldUsers);
  assert.equal(after.maskUsers, before.maskUsers);
  assert.equal(after.maskSlots, before.maskSlots);
  assert.equal(after.live, before.live);
  assert.notEqual(after.byId, before.byId);
  assert.equal(after.byId.get('amount').value, .4);
  assert.equal(maskInfo(next, 'surface').strength.value, .4);
  const changed = appendPaint(next, {field: 'baseField'}).graph;
  assert.notEqual(graphIndex(changed).maskUsers, before.maskUsers);
  assert.equal(graphIndex(changed).fieldUsers.get('baseField').length, 3);
});

test('shared mapping gestures do not reclassify unchanged paint styles', () => {
  let graph = composeSurface();
  while (graphIndex(graph).paints.length < 8) graph = appendPaint(graph, {field: 'baseField'}).graph;
  const initialViews = paintsIn(graph);
  const stableStyles = new Set(graphIndex(graph).paints.map(paint => paint.style));
  const stablePalettes = new Set([...stableStyles].map(style => style.palette));
  const stringify = JSON.stringify;
  let classifications = 0;
  try {
    JSON.stringify = function(value, ...rest) {
      if (stableStyles.has(value) || stablePalettes.has(value)) classifications++;
      return stringify.call(JSON, value, ...rest);
    };
    for (let i = 0; i < 60; i++) {
      graph = patchGraph(graph, {baseField: {scale: .1 + i / 1000}});
      const views = paintsIn(graph);
      assert.deepEqual(views.map(view => view.label), initialViews.map(view => view.label));
      assert.ok(views.every(view => view.mapping.scale === .1 + i / 1000));
    }
  } finally { JSON.stringify = stringify; }
  assert.equal(classifications, 0, 'Style identity, not the changing field, owns classification.');
});

test('version43 recipes migrate and invalid imports or edits leave the accepted graph intact', () => {
  const graph = COMPOSITION_EXAMPLES.patina.create(), original = serializeGraph(graph);
  const imported = paintsIn(parseSurface(JSON.stringify(SURFACE_PRESETS.horn.recipe)))[0], expected = splitRecipe('horn');
  assert.deepEqual(imported.style, expected.style);
  for (const [key, value] of Object.entries(expected.mapping)) assert.deepEqual(imported.mapping[key], value);
  for (const source of ['{', '{"version":2,"nodes":[],"output":"missing"}', '{"version":1,"nodes":[],"output":"missing"}', '{"palette":{"base":"red"}}']) assert.throws(() => parseSurface(source));
  assert.throws(() => patchGraph(graph, {baseField: {scale: 0}}));
  assert.throws(() => changePaintField(graph, 'basePaint', 'missing'));
  assert.equal(serializeGraph(graph), original);
});

test('procedural source inspection exposes editable color and field values without a paint prerequisite', () => {
  const graph = COMPOSITION_EXAMPLES.stone.create(), index = graphIndex(graph);
  assert.equal(index.paints.length, 0);
  assert.equal(index.fields.length, 0);
  assert.deepEqual(index.sources.map(node => node.kind), ['material']);
  assert.deepEqual(new Set(index.surfaceControls.map(node => node.kind)), new Set(['transform', 'noise', 'ramp', 'color', 'colorMix', 'parameter']));
  assert.deepEqual(new Set(index.users.get('stoneGrain')), new Set([
    'stoneTone', graph.nodes.find(node => node.kind === 'multiply').id,
  ]));
  const next = patchGraph(graph, {stoneGrain: {seed: 84}, stoneShadow: {value: [.1, .2, .3]}}), changed = graphIndex(next);
  assert.equal(changed.users, index.users);
  assert.equal(changed.surfaceControls.find(node => node.id === 'stoneGrain').seed, 84);
  assert.deepEqual(changed.surfaceControls.find(node => node.id === 'stoneShadow').value, [.1, .2, .3]);
});

test('replacing a procedural blend mask retains the field still used by color', () => {
  const graph = COMPOSITION_EXAMPLES.lichen.create(), before = graphIndex(graph);
  assert.equal(maskInfo(graph, 'lichenShell').mode, 'custom');
  assert.deepEqual(new Set(maskInfo(graph, 'lichenShell').controls.map(node => node.kind)), new Set(['transform', 'noise', 'ramp']));
  const next = replaceBlendMask(graph, 'lichenShell', 'height'), after = graphIndex(next);
  assert.equal(maskInfo(next, 'lichenShell').mode, 'height');
  assert.deepEqual(after.byId.get('lichenNoise'), before.byId.get('lichenNoise'));
  assert.deepEqual(after.byId.get('lichenSpace'), before.byId.get('lichenSpace'));
  assert.equal(after.byId.has('lichenCoverage'), false);
  assert.ok(after.surfaceControls.some(node => node.id === 'lichenNoise'));
  assert.equal(maskInfo(next, 'lichenShell').coordinate.domain, 'lichenSpace');
  assert.ok(maskInfo(next, 'lichenShell').controls.some(node => node.id === 'lichenSpace'));
  assert.equal(after.sources.length, 2);
});

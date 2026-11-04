import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoot} from 'solid-js';
import {createEditor} from '../lab/editor.ts';
import {composeSurface} from '../lab/composition.mts';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';
import {color, evaluateColor, materialGraph, named, patchGraph, scalar, surface} from '../src/core.mjs';
import {addRampStop, canAddRampStop, colorSources} from '../lab/color-authoring.mts';
import {surfaceFinish} from '../lab/surface-authoring.mts';
import {decodeSession} from '../lab/session.mts';

function harness(t, initial) {
  return createRoot(dispose => {
    const frames = new Map(), commits = [];
    let sequence = 0, reject = false;
    const editor = createEditor({
      initial,
      commit(graph, plan) {
        if (reject) throw new Error('Renderer rejected the proposed graph');
        commits.push({graph, plan});
      },
      invalidate() {},
      frames: {request(callback) {const id = ++sequence; frames.set(id, callback); return id;}, cancel(id) {frames.delete(id);}},
    });
    t.after(() => {editor.dispose(); dispose();});
    return {editor, frames, commits, reject(value) {reject = value;}};
  });
}

function advanceFrame(frames) {
  const [id, callback] = frames.entries().next().value;
  frames.delete(id); callback(0);
}

function session(graph, values = {}) {
  return {graph, baseline: graph, selectedPaint: 'basePaint', selectedBlend: null,
    tab: 'compose', sourceDraft: null, sourceOpen: false, ...values};
}

test('height detail edits keep one field shared, preserve drafts and restore exact graph history', t => {
  const {editor} = harness(t, session(COMPOSITION_EXAMPLES.stone.create()));
  editor.openSource(); editor.editSource('unfinished surface draft');
  const original = editor.graph();
  assert.equal(editor.addDetail('stoneGrain'), true);
  const detailed = editor.graph(), detail = editor.index().byId.get(detailed.output);
  const height = editor.index().byId.get(detail.height), amplitude = height.a;
  const program = editor.plan().programKey;
  assert.ok(editor.surfaceControlIds().includes(amplitude));
  editor.queue({[amplitude]: {value: -.06}});
  assert.equal(editor.gestureEnd(), true);
  assert.equal(editor.plan().programKey, program);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), detailed);
  assert.equal(editor.setDetailHeight(detail.id, 'stoneTone'), true);
  assert.equal(editor.index().byId.has(amplitude), false);
  assert.equal(editor.removeDetail(detail.id), true);
  assert.equal(editor.graph().output, original.output);
  assert.equal(editor.sourceText(), 'unfinished surface draft');
  assert.equal(editor.undo(), true);
  assert.equal(editor.index().byId.get(detail.id).height, 'stoneTone');
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), detailed);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), original);
});

test('height and finish connections reject invalid graphs without changing the accepted document', t => {
  const {editor, reject} = harness(t, session(COMPOSITION_EXAMPLES.weathered.create()));
  const original = editor.graph();
  assert.equal(editor.setDetailHeight(original.output, 'weatherBlue'), false);
  assert.equal(editor.graph(), original);
  assert.match(editor.notice().message, /expects scalar/);
  assert.equal(editor.setFinishField('roughness', 'weatherBlue'), false);
  assert.equal(editor.graph(), original);
  reject(true);
  assert.equal(editor.addDetail('weatherGrain'), false);
  assert.equal(editor.graph(), original);
  assert.equal(editor.canUndo(), false);
});

test('finish connections under height compose through the existing undo and parameter-edit paths', t => {
  const {editor} = harness(t, session(COMPOSITION_EXAMPLES.weathered.create()));
  const original = editor.graph();
  assert.equal(editor.setFinishField('roughness', 'weatherPatina'), true);
  assert.equal(surfaceFinish(editor.graph()).values.roughness, 'weatherPatina');
  assert.equal(editor.setFinishField('clearcoat', 'weatherPatina'), true);
  assert.equal(editor.plan().cost.proceduralSamples, 1);
  assert.equal(editor.exposeFinishValue('clearcoat'), true);
  const parameter = surfaceFinish(editor.graph()).values.clearcoat, program = editor.plan().programKey;
  editor.queue({[parameter]: {value: .3}}); editor.gestureEnd();
  assert.equal(editor.plan().programKey, program);
  assert.equal(editor.setFinishField('clearcoat'), true);
  assert.equal(editor.index().byId.has(parameter), false);
  assert.ok(editor.index().byId.has('weatherPatina'));
  for (let i = 0; i < 5; i++) assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), original);
});

test('procedural pigments edit through the paint and color controls with reversible connections', t => {
  const {editor} = harness(t);
  assert.equal(editor.useExample('prismatic'), true);
  const original = editor.graph(), key = editor.plan().programKey;
  assert.equal(editor.chosenPaint().palette.base, 'shellPalette');
  assert.ok(editor.surfaceControlIds().includes('shellPalette'));
  editor.setColorChannel('shellTeal', 1, .4);
  assert.equal(editor.gestureEnd(), true);
  assert.equal(editor.plan().programKey, key);
  assert.equal(editor.plan().cost.paintSamples, 1);
  assert.equal(editor.plan().cost.proceduralSamples, 1);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), original);
  editor.openSource(); editor.editSource('{"unfinished": true}');
  assert.equal(editor.separatePaintColor('base'), true);
  assert.equal(editor.index().byId.get(editor.chosenPaint().palette.base).kind, 'color');
  assert.ok(editor.index().byId.has('shellPalette'), 'Other pigment roles still depend on the shared ramp.');
  assert.equal(editor.sourceText(), '{"unfinished": true}');
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), original);
});

test('paint numeric colors retain extended values and shared uses until explicitly made independent', t => {
  const pigment = named('pigment', color.linear([-.3, .2, 1.4]));
  const graph = materialGraph(surface.paint('carapace', {palette: {base: pigment, shadow: pigment}}));
  const {editor} = harness(t, session(graph));
  const key = editor.plan().programKey;
  editor.setColorChannel('pigment', 1, .6);
  assert.equal(editor.gestureEnd(), true);
  assert.deepEqual(editor.index().byId.get('pigment').value, [-.3, .6, 1.4]);
  assert.equal(editor.chosenPaint().palette.base, editor.chosenPaint().palette.shadow);
  assert.equal(editor.plan().programKey, key);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), graph);
  assert.equal(editor.separatePaintColor('base'), true);
  const independent = editor.chosenPaint().palette.base;
  assert.notEqual(independent, 'pigment');
  assert.deepEqual(editor.index().byId.get(independent).value, [-.3, .2, 1.4]);
  editor.setColorChannel(independent, 0, -.4);
  assert.equal(editor.gestureEnd(), true);
  assert.deepEqual(editor.index().byId.get(independent).value, [-.4, .2, 1.4]);
  assert.deepEqual(editor.index().byId.get('pigment').value, [-.3, .2, 1.4]);
  assert.equal(editor.undo(), true);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), graph);
});

test('choosing a paint preset removes procedural pigment overrides and remains undoable', t => {
  const {editor} = harness(t);
  editor.useExample('prismatic');
  const before = editor.graph();
  assert.equal(editor.applyPreset('horn'), true);
  assert.deepEqual(Object.keys(editor.chosenPaint().palette), ['base', 'shadow', 'light']);
  assert(Object.values(editor.chosenPaint().palette).every(id => editor.index().byId.get(id).kind === 'color'));
  assert.equal(editor.chosenPaint().preset, 'horn');
  assert.equal(editor.plan().cost.proceduralSamples, 0);
  assert.equal(editor.plan().cost.paintSamples, 1);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), before);
});

test('color-ramp stop edits preserve programs, reject crossing stops atomically and retain source drafts', t => {
  const {editor} = harness(t);
  editor.useExample('spectrum'); editor.openSource(); editor.editSource('unfinished ramp draft');
  const before = editor.graph(), key = editor.plan().programKey;
  editor.setRampPosition('bandPalette', 1, .31);
  assert.equal(editor.gestureEnd(), true);
  assert.equal(editor.plan().programKey, key);
  const accepted = editor.graph();
  editor.setRampPosition('bandPalette', 1, .9);
  assert.equal(editor.gestureEnd(), false);
  assert.equal(editor.graph(), accepted);
  assert.equal(editor.sourceText(), 'unfinished ramp draft');
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), before);
  assert.equal(editor.addRampStop('bandPalette'), true);
  assert.equal(editor.index().byId.get('bandPalette').colors.length, 5);
  const added = editor.graph();
  assert.equal(editor.setColorProgram('bandPalette', {interpolation: 'constant'}), true);
  assert.notEqual(editor.plan().programKey, key);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), added);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), before);
});

test('color connections offer acyclic fields and invalid cyclic rewiring preserves the accepted graph', t => {
  const a = named('first', color.srgb('#123456')), b = named('second', color.srgb('#abcdef'));
  const ramp = named('rampColor', color.ramp(scalar.axis('y'), [[0, a], [1, b]]));
  const consumer = named('dependent', color.mix(ramp, b, .3));
  const graph = materialGraph(surface.material(consumer));
  const {editor} = harness(t, session(graph));
  assert.deepEqual(colorSources(graph, 'rampColor').map(node => node.id), ['first', 'second']);
  assert.equal(editor.setRampColor('rampColor', 0, 'dependent'), false);
  assert.equal(editor.graph(), graph);
  assert.equal(editor.notice().error, true);
});

test('adding a stop takes the current Oklab midpoint and keeps varying endpoints as fields', () => {
  for (const varying of [false, true]) {
    const first = named('first', varying ? color.mix(color.srgb('#15344a'), color.srgb('#6abb95'), scalar.ramp(scalar.axis('x'), -1, 1)) : color.linear([0, 1, 0]));
    const last = named('last', color.linear([0, 0, 1]));
    const graph = materialGraph(surface.material(named('palette', color.ramp(scalar.axis('y'), [[0, first], [1, last]], {space: 'oklab'}))));
    const added = addRampStop(graph, 'palette');
    for (const x of [-.7, 0, .6]) {
      const expected = evaluateColor(graph, 'palette', {position: [x, .5, 0]}).value;
      const actual = evaluateColor(added, 'palette', {position: [x, .5, 0]}).value;
      actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-12));
    }
    const ramp = added.nodes.find(node => node.id === 'palette');
    const middle = added.nodes.find(node => node.id === ramp.colors[1]);
    assert.equal(middle.kind, varying ? 'colorMix' : 'color');
    if (!varying) assert.ok(middle.value[0] < 0, 'The new color retains the out-of-gamut midpoint.');
  }
});

test('a ramp with no valid space for another stop disables insertion without changing its graph', () => {
  const graph = materialGraph(surface.material(named('tight', color.ramp(scalar.axis('x'), [
    [0, color.srgb('#123456')], [1e-6, color.srgb('#abcdef')],
  ]))));
  assert.equal(canAddRampStop(graph, 'tight'), false);
  assert.throws(() => addRampStop(graph, 'tight'), /No room/);
  assert.equal(graph.nodes.find(node => node.id === 'tight').colors.length, 2);
});

test('Solid editor batches independent value edits and leaves source serialization lazy', t => {
  const {editor, frames, commits} = harness(t);
  assert.equal(editor.metrics().sourceWrites, 0);
  editor.useExample('belly'); commits.length = 0;
  const before = editor.graph(), structure = editor.plan().structure;
  editor.queue({amount: {value: .3}});
  editor.queueStyle({contrast: .4});
  editor.setColorHex(editor.chosenPaint().palette.base, '#123456');
  editor.setColorHex(editor.chosenPaint().palette.light, '#abcdef');
  assert.equal(frames.size, 1);
  assert.equal(editor.graph(), before);
  assert.equal(editor.flush(), true);
  assert.equal(commits.length, 1);
  assert.equal(editor.plan().structure, structure);
  assert.equal(editor.index().byId.get('amount').value, .3);
  assert.equal(editor.chosenPaint().style.contrast, .4);
  assert.deepEqual(editor.index().byId.get(editor.chosenPaint().palette.base).value, color.srgb('#123456').value);
  assert.deepEqual(editor.index().byId.get(editor.chosenPaint().palette.light).value, color.srgb('#abcdef').value);
  assert.equal(editor.metrics().sourceWrites, 0);
  assert.equal(editor.metrics().valueCommits, 1);
  assert.equal(editor.openSource(), true);
  assert.equal(editor.metrics().sourceWrites, 1);
  assert.deepEqual(JSON.parse(editor.sourceText()), editor.graph());
});

test('unapplied source survives accepted live edits and only an explicit refresh replaces it', t => {
  const {editor} = harness(t);
  editor.useExample('belly'); editor.openSource();
  const draft = editor.sourceText().replace('0.94', '0.72');
  editor.editSource(draft);
  editor.queue({amount: {value: .2}});
  assert.equal(editor.gestureEnd(), true);
  assert.equal(editor.sourceDirty(), true);
  assert.equal(editor.sourceText(), draft);
  assert.equal(editor.sourceForCopy(), draft);
  assert.equal(editor.index().byId.get('amount').value, .2);
  assert.equal(editor.refreshSource(), true);
  assert.equal(editor.sourceDirty(), false);
  assert.deepEqual(JSON.parse(editor.sourceText()), editor.graph());
});

test('region changes after reversal preserve the pending strength, source draft and undo history', t => {
  const {editor, frames} = harness(t);
  editor.useExample('belly'); editor.openSource();
  const draft = editor.sourceText().replace('0.94', '0.72');
  editor.editSource(draft);
  editor.queue({amount: {value: .37}});
  assert.equal(editor.reverseMask(), true);
  assert.equal(frames.size, 0);
  const reversed = editor.graph();
  assert.equal(editor.mask().mode, 'facing');
  assert.equal(editor.mask().strength.value, .37);
  assert.equal(editor.setRegion('height'), true);
  const changed = editor.graph();
  assert.equal(editor.mask().mode, 'height');
  assert.equal(editor.mask().strength.id, 'amount');
  assert.equal(editor.mask().strength.value, .37);
  assert.equal(editor.sourceText(), draft);
  assert.equal(editor.sourceDirty(), true);
  assert.equal(editor.undoLabel(), 'Change blend region');
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), reversed);
  assert.equal(editor.mask().mode, 'facing');
  assert.equal(editor.redo(), true);
  assert.equal(editor.graph(), changed);
  assert.equal(editor.sourceText(), draft);
  assert.equal(editor.setRegion('height'), true);
  assert.equal(editor.graph(), changed);
  assert.equal(editor.undoLabel(), 'Change blend region');
});

test('a failed renderer commit preserves graph, plan and selection atomically', t => {
  const {editor, reject} = harness(t);
  editor.useExample('belly');
  const before = {graph: editor.graph(), plan: editor.plan(), paint: editor.selectedPaint(), blend: editor.selectedBlend()};
  reject(true);
  assert.equal(editor.addPaint(), false);
  assert.equal(editor.graph(), before.graph);
  assert.equal(editor.plan(), before.plan);
  assert.equal(editor.selectedPaint(), before.paint);
  assert.equal(editor.selectedBlend(), before.blend);
  assert.match(editor.notice().message, /Renderer rejected/);
  reject(false);
  assert.equal(editor.addPaint(), true);
  assert.equal(editor.paints().length, 3);
});

test('source errors keep the accepted graph and valid drafts become the new baseline', t => {
  const {editor} = harness(t);
  editor.useExample('belly'); editor.openSource();
  const accepted = editor.graph(), source = editor.sourceText();
  editor.editSource('{');
  assert.equal(editor.applySource(), false);
  assert.equal(editor.graph(), accepted);
  assert.equal(editor.sourceDirty(), true);
  assert.ok(editor.sourceError());
  editor.editSource(source.replace('0.94', '0.62'));
  assert.equal(editor.applySource(), true);
  assert.equal(editor.index().byId.get('amount').value, .62);
  assert.equal(editor.sourceDirty(), false);
  assert.equal(editor.edited(), false);
  editor.queue({amount: {value: .12}}); editor.gestureEnd();
  assert.equal(editor.edited(), true);
  editor.reset();
  assert.equal(editor.index().byId.get('amount').value, .62);
});

test('real Solid derivations retain independent layers and selected blend identity', t => {
  const {editor} = harness(t);
  editor.useExample('belly'); editor.addPaint(); editor.addPaint();
  assert.equal(editor.paintIds().length, 4);
  assert.equal(editor.blendIds().length, 3);
  const outer = editor.graph().output, selected = editor.selectedPaint();
  editor.selectBlend('surface'); editor.queue({amount: {value: .51}}); editor.flush();
  assert.equal(editor.graph().output, outer);
  assert.equal(editor.selectedPaint(), selected);
  assert.equal(editor.selectedBlend(), 'surface');
  const priorField = editor.chosenPaint().mapping.id;
  editor.separateField();
  assert.notEqual(editor.chosenPaint().mapping.id, priorField);
  assert.equal(editor.plan().cost.textureReads, 8);
  assert.equal(editor.index().fieldUsers.get(priorField).length, 3);
});

test('many preview frames form one completed gesture and one undo step', t => {
  const {editor, frames, commits} = harness(t), before = editor.graph();
  editor.openSource();
  for (const roughness of [.1, .2]) {
    editor.queueStyle({roughness}); advanceFrame(frames);
    assert.equal(editor.metrics().sourceWrites, 1, 'A preview does not rewrite the open source view.');
  }
  editor.queueStyle({roughness: .3});
  assert.equal(editor.gestureEnd(), true);
  const after = editor.graph();
  assert.equal(commits.length, 3);
  assert.equal(editor.metrics().sourceWrites, 2);
  assert.equal(editor.undoLabel(), 'Adjust values');
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), before);
  assert.equal(editor.canUndo(), false);
  assert.equal(editor.canRedo(), true);
  assert.equal(editor.redo(), true);
  assert.equal(editor.graph(), after);
  assert.equal(editor.canRedo(), false);
});

test('selection, identical values and rejected edits preserve redo; accepted new edits replace it', t => {
  const {editor} = harness(t), initial = editor.graph();
  editor.addPaint(); editor.undo();
  editor.showTab('paint'); editor.selectPaint('basePaint');
  assert.equal(editor.setField(editor.chosenPaint().mapping.id), true);
  editor.queueStyle({roughness: editor.chosenPaint().style.roughness});
  assert.equal(editor.gestureEnd(), true);
  assert.equal(editor.graph(), initial);
  assert.equal(editor.canUndo(), false);
  assert.equal(editor.canRedo(), true);
  editor.queueStyle({roughness: NaN});
  assert.equal(editor.gestureEnd(), false);
  assert.equal(editor.graph(), initial);
  assert.equal(editor.canUndo(), false);
  assert.equal(editor.canRedo(), true);
  editor.queueStyle({roughness: .1}); editor.gestureEnd();
  assert.equal(editor.canUndo(), true);
  assert.equal(editor.canRedo(), false);
});

test('structural undo restores pruned definitions and the selected blend without touching a source draft', t => {
  const {editor} = harness(t);
  editor.useExample('belly'); editor.addPaint(); editor.selectBlend('surface');
  const before = editor.graph(), paint = editor.selectedPaint(), blend = editor.selectedBlend();
  editor.openSource(); editor.editSource('a deliberately unfinished draft');
  assert.equal(editor.removeBlend(), true);
  const after = editor.graph();
  assert.equal(editor.index().byId.has('surface'), false);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), before);
  assert.equal(editor.selectedPaint(), paint);
  assert.equal(editor.selectedBlend(), blend);
  assert.equal(editor.sourceText(), 'a deliberately unfinished draft');
  assert.equal(editor.redo(), true);
  assert.equal(editor.graph(), after);
  assert.equal(editor.sourceDirty(), true);
});

test('renderer rejection leaves the proposed undo and its selection available', t => {
  const {editor, reject} = harness(t);
  editor.useExample('belly');
  const before = editor.session(), plan = editor.plan();
  reject(true);
  assert.equal(editor.undo(), false);
  assert.equal(editor.session(), before);
  assert.equal(editor.plan(), plan);
  assert.equal(editor.canUndo(), true);
  assert.equal(editor.canRedo(), false);
  reject(false);
  assert.equal(editor.undo(), true);
  assert.equal(editor.paints().length, 1);
  assert.equal(editor.canUndo(), false);
});

test('reset and example history restore the matching baseline and preserve unapplied source', t => {
  const {editor} = harness(t), original = editor.graph();
  editor.queueStyle({roughness: .2}); editor.gestureEnd();
  const edited = editor.graph();
  editor.openSource(); editor.editSource('{in progress');
  editor.reset();
  assert.equal(editor.graph(), original);
  assert.equal(editor.edited(), false);
  editor.undo();
  assert.equal(editor.graph(), edited);
  assert.equal(editor.session().baseline, original);
  assert.equal(editor.edited(), true);
  editor.useExample('belly');
  assert.equal(editor.session().baseline, editor.graph());
  assert.equal(editor.edited(), false);
  editor.undo();
  assert.equal(editor.graph(), edited);
  assert.equal(editor.session().baseline, original);
  assert.equal(editor.sourceText(), '{in progress');
});

test('hydration restores document and draft before history begins without a renderer commit', t => {
  const baseline = COMPOSITION_EXAMPLES.belly.create();
  const graph = patchGraph(baseline, {amount: {value: .2}});
  const {editor, commits} = harness(t, session(graph, {baseline, selectedPaint: 'missing', selectedBlend: 'missing',
    tab: 'paint', sourceDraft: '', sourceOpen: true}));
  assert.equal(commits.length, 0);
  assert.equal(editor.graph(), graph);
  assert.equal(editor.session().baseline, baseline);
  assert.equal(editor.edited(), true);
  assert.equal(editor.selectedPaint(), 'basePaint');
  assert.equal(editor.selectedBlend(), 'surface');
  assert.equal(editor.tab(), 'paint');
  assert.equal(editor.sourceOpen(), true);
  assert.equal(editor.sourceDirty(), true, 'An empty source draft is still a draft.');
  assert.equal(editor.sourceText(), '');
  assert.equal(editor.metrics().sourceWrites, 0);
  assert.equal(editor.canUndo(), false);
  assert.equal(editor.canRedo(), false);
});

test('a migrated version-one session keeps its reset baseline and source draft through new edits and undo', t => {
  const baseline = COMPOSITION_EXAMPLES.belly.create(), graph = patchGraph(baseline, {amount: {value: .23}});
  const previous = {version: 1, ...session(graph, {baseline, selectedPaint: 'accentPaint', selectedBlend: 'surface',
    tab: 'paint', sourceDraft: '{ unfinished migration draft', sourceOpen: true})};
  const restored = decodeSession(JSON.stringify(previous));
  const {editor} = harness(t, restored);
  assert.deepEqual(editor.graph(), graph);
  assert.deepEqual(editor.session().baseline, baseline);
  assert.equal(editor.selectedPaint(), 'accentPaint');
  assert.equal(editor.edited(), true);
  assert.equal(editor.canUndo(), false, 'History begins at the restored document.');
  editor.queue({amount: {value: .41}});
  assert.equal(editor.gestureEnd(), true);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), restored.graph);
  assert.equal(editor.reset(), true);
  assert.equal(editor.graph(), restored.baseline);
  assert.equal(editor.edited(), false);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), restored.graph);
  assert.equal(editor.sourceText(), previous.sourceDraft);
});

test('a discrete paint command closes earlier previews as a separate undo entry', t => {
  const {editor, frames} = harness(t), initial = editor.graph();
  editor.queueStyle({roughness: .2}); advanceFrame(frames);
  const preview = editor.graph();
  assert.equal(editor.applyPreset('horn'), true);
  assert.equal(editor.undoLabel(), 'Apply paint preset');
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), preview);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), initial);
  assert.equal(editor.canUndo(), false);
});

test('channel and relief parameters are exposed once and retain independent graph references', t => {
  const base = composeSurface();
  const graph = materialGraph({...base, nodes: [...base.nodes,
    {id: 'gain', kind: 'parameter', value: .4},
    {id: 'reliefLayer', kind: 'relief', input: base.output, scale: 'gain'},
    {id: 'rough', kind: 'parameter', value: .25},
    {id: 'maskAmount', kind: 'parameter', value: .6},
    {id: 'channelLayer', kind: 'channels', input: 'reliefLayer', values: {roughness: 'rough', clearcoat: 'maskAmount'}},
    {id: 'mixed', kind: 'mix', a: 'channelLayer', b: base.output, mask: 'maskAmount'},
    {id: 'unused', kind: 'parameter', value: .9},
  ], output: 'mixed'});
  const {editor} = harness(t, session(graph)), structure = editor.plan().structure;
  assert.deepEqual(editor.surfaceControlIds(), ['gain', 'rough']);
  assert.deepEqual(editor.maskControlIds(), ['maskAmount']);
  assert.equal(editor.surfaceLabel('channelLayer'), editor.surfaceLabel(base.output));
  editor.queue({gain: {value: .8}}); editor.queue({rough: {value: .35}});
  assert.equal(editor.gestureEnd(), true);
  assert.equal(editor.index().byId.get('gain').value, .8);
  assert.equal(editor.index().byId.get('rough').value, .35);
  assert.equal(editor.index().byId.get('maskAmount').value, .6);
  assert.equal(editor.index().byId.get('reliefLayer'), graph.nodes.find(node => node.id === 'reliefLayer'));
  assert.equal(editor.index().byId.get('channelLayer'), graph.nodes.find(node => node.id === 'channelLayer'));
  assert.equal(editor.plan().structure, structure);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), graph);
});

test('a multi-frame gesture returning to its start preserves document identity, redo and source draft', t => {
  const {editor, frames} = harness(t);
  editor.addPaint(); const redoGraph = editor.graph(); editor.undo();
  const before = editor.graph(), plan = editor.plan(), paint = editor.chosenPaint();
  editor.openSource(); editor.editSource('{unfinished');
  const sourceWrites = editor.metrics().sourceWrites;
  editor.queueStyle({roughness: .2});
  editor.setColorHex(paint.palette.base, '#123456');
  editor.queueMapping({scale: .333}); advanceFrame(frames);
  assert.equal(editor.edited(), true);
  assert.equal(editor.canRedo(), false, 'Redo is unavailable while the preview differs from its starting document.');
  editor.queueStyle({roughness: paint.style.roughness});
  editor.queue({[paint.palette.base]: {value: before.nodes.find(node => node.id === paint.palette.base).value}});
  editor.queueMapping({scale: paint.mapping.scale}); advanceFrame(frames);
  assert.equal(editor.gestureEnd(), true);
  assert.equal(editor.graph(), before);
  assert.equal(editor.plan(), plan);
  assert.equal(editor.edited(), false);
  assert.equal(editor.canUndo(), false);
  assert.equal(editor.canRedo(), true);
  assert.equal(editor.sourceText(), '{unfinished');
  assert.equal(editor.metrics().sourceWrites, sourceWrites);
  assert.equal(editor.redo(), true);
  assert.equal(editor.graph(), redoGraph);
  assert.equal(editor.sourceText(), '{unfinished');
});

test('invalid and renderer-rejected previews never enter the accepted cumulative patch', t => {
  const {editor, frames, commits, reject} = harness(t), before = editor.graph();
  const original = editor.chosenPaint();
  editor.queueStyle({roughness: .2});
  editor.setColorHex(original.palette.base, '#112233'); advanceFrame(frames);
  const accepted = editor.graph();
  for (const invalid of [{roughness: NaN, palette: {shadow: '#abcdef'}}, {unknown: undefined}, [], {palette: []}, new Date(0)]) {
    editor.queueStyle(invalid); advanceFrame(frames);
    assert.equal(editor.graph(), accepted);
    assert.equal(editor.notice().error, true);
  }
  editor.queueStyle({roughness: .3}); advanceFrame(frames);
  assert.deepEqual(editor.index().byId.get(original.palette.base).value, color.srgb('#112233').value);
  assert.equal(editor.index().byId.get(original.palette.shadow), before.nodes.find(node => node.id === original.palette.shadow));
  reject(true); editor.queueMapping({seed: 123}); advanceFrame(frames); reject(false);
  editor.queueStyle({marks: .4}); advanceFrame(frames);
  assert.equal(editor.chosenPaint().mapping.seed, original.mapping.seed);
  editor.queueStyle({clearcoat: original.style.clearcoat}); advanceFrame(frames);
  editor.queueStyle({roughness: .3, marks: .4});
  editor.setColorHex(original.palette.base, '#112233'); advanceFrame(frames);
  assert.equal(commits.length, 3, 'Repeated accepted values do not produce another preview commit.');
  assert.equal(editor.gestureEnd(), true);
  assert.equal(editor.chosenPaint().style.roughness, .3);
  assert.equal(editor.chosenPaint().style.marks, .4);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), before);
  assert.equal(editor.canUndo(), false);
});

test('paint controls address canonical style and shared mapping independently', t => {
  const {editor, frames} = harness(t);
  editor.useExample('belly'); editor.selectPaint('accentPaint');
  const before = editor.graph(), base = editor.paintById().get('basePaint'), accent = editor.chosenPaint();
  assert.equal(base.mapping, accent.mapping);
  assert.equal(accent.mapping, editor.index().byId.get(accent.mapping.id));
  assert.equal(accent.style, editor.index().byId.get('accentPaint').style);
  editor.queueStyle({roughness: .1}); advanceFrame(frames);
  assert.equal(editor.paintById().get('basePaint'), base);
  assert.equal(editor.chosenPaint().mapping, accent.mapping);
  editor.queueMapping({scale: .31}); advanceFrame(frames); editor.gestureEnd();
  const nextBase = editor.paintById().get('basePaint'), nextAccent = editor.chosenPaint();
  assert.equal(nextBase.style, base.style);
  assert.equal(nextBase.mapping, nextAccent.mapping);
  assert.equal(nextBase.mapping, editor.index().byId.get('baseField'));
  assert.equal(nextBase.mapping.scale, .31);
  assert.equal(nextAccent.style.roughness, .1);
  editor.undo();
  assert.equal(editor.graph(), before);
  assert.deepEqual(editor.chosenPaint(), accent, 'Undo restores the same values without retaining a cache of every field revision.');
});

test('generic surface controls edit literals, transitions and directions without rewriting their expressions', t => {
  const direction = named('finishDirection', scalar.facing([0, 1, 0]));
  const roughness = named('finishRamp', scalar.ramp(direction, -1, 1));
  const gain = named('reliefLiteral', scalar.constant(.7));
  const graph = materialGraph(surface.channels(surface.relief(surface.paint('carapace'), gain),
    {roughness, metalness: named('metalness', scalar.parameter(.15))}));
  const {editor, frames} = harness(t, session(graph));
  assert.deepEqual(new Set(editor.surfaceControlIds()), new Set(['finishDirection', 'finishRamp', 'reliefLiteral', 'metalness']));
  assert.deepEqual(editor.maskControlIds(), []);
  editor.openSource(); editor.editSource('keep this draft');
  editor.setBoundary('finishRamp', 'center', .25); advanceFrame(frames);
  editor.setBoundary('finishRamp', 'width', 1);
  editor.setDirection('finishDirection', 0, 1); advanceFrame(frames);
  editor.setDirection('finishDirection', 1, 0); advanceFrame(frames);
  editor.queue({finishDirection: {direction: [1, 0, 0]}}); advanceFrame(frames);
  editor.queue({finishDirection: {direction: [2, 0, 0]}}); advanceFrame(frames);
  assert.equal(editor.metrics().valueCommits, 3, 'An equivalent vector does not repeat the accepted preview.');
  editor.gestureEnd();
  assert.deepEqual(editor.index().byId.get('finishDirection').direction, [1, 0, 0]);
  const ramp = editor.index().byId.get('finishRamp');
  assert.equal(ramp.low, -.25); assert.equal(ramp.high, .75);
  assert.equal(ramp.input, 'finishDirection');
  const beforeLiteral = editor.graph();
  assert.equal(editor.setLiteral('reliefLiteral', .9), true);
  assert.equal(editor.index().byId.get('reliefLiteral').kind, 'constant');
  assert.equal(editor.index().byId.get('reliefLiteral').value, .9);
  assert.equal(editor.sourceText(), 'keep this draft');
  editor.undo(); assert.equal(editor.graph(), beforeLiteral);
  editor.undo(); assert.equal(editor.graph(), graph);
});

test('Directional finish starts as a named editable composition with no blend prerequisite', t => {
  const {editor} = harness(t);
  assert.equal(editor.useExample('finish'), true);
  assert.equal(editor.paintIds().length, 1);
  assert.equal(editor.selectedPaint(), 'carapacePaint');
  assert.equal(editor.selectedBlend(), null);
  assert.equal(editor.plan().cost.textureReads, 4);
  assert.deepEqual(new Set(editor.surfaceControlIds()), new Set(['reliefGain', 'finishDirection', 'roughnessRamp', 'metalness']));
  editor.queue({reliefGain: {value: .3}, metalness: {value: .4}}); editor.gestureEnd();
  assert.equal(editor.index().byId.get('reliefGain').value, .3);
  assert.equal(editor.index().byId.get('metalness').value, .4);
  assert.equal(editor.index().byId.get('roughnessRamp').kind, 'ramp');
});

test('a procedural surface can import, add and remove paint, and traverse history with no selected paint', t => {
  const graph = COMPOSITION_EXAMPLES.stone.create();
  const {editor} = harness(t, session(graph, {selectedPaint: null, tab: 'paint', sourceDraft: '{ unfinished'}));
  assert.equal(editor.selectedPaint(), null);
  assert.equal(editor.chosenPaint(), null);
  assert.equal(editor.liveSources().length, 1);
  assert.equal(editor.livePaints().length, 0);
  assert.match(editor.title(), /stoneMaterial/);
  assert.match(editor.expression(), /material/);
  assert.equal(editor.addPaint(), true);
  const withPaint = editor.graph(), paint = editor.selectedPaint();
  assert.equal(editor.paintIds().length, 1);
  assert.equal(editor.chosenPaint().id, paint);
  assert.equal(editor.removeBlend(), true);
  assert.equal(editor.selectedPaint(), null);
  assert.equal(editor.chosenPaint(), null);
  assert.equal(editor.index().fields.length, 0);
  assert.deepEqual(editor.graph().nodes, graph.nodes);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), withPaint);
  assert.equal(editor.selectedPaint(), paint);
  assert.equal(editor.redo(), true);
  assert.equal(editor.selectedPaint(), null);
  assert.equal(editor.sourceText(), '{ unfinished');
  assert.equal(editor.importSource(JSON.stringify(graph)), true);
  assert.equal(editor.selectedPaint(), null);
  assert.equal(editor.sourceDirty(), false);
  assert.deepEqual(JSON.parse(editor.acceptedSource()), graph);
});

test('procedural color, noise and matrix edits compose in a frame and retain one reversible value gesture', t => {
  const {editor, frames, commits} = harness(t);
  editor.useExample('stone'); commits.length = 0;
  const before = editor.graph(), structure = editor.plan().structure;
  editor.setColorChannel('stoneShadow', 0, .15);
  editor.setColorChannel('stoneShadow', 2, .25);
  editor.setMatrixCell('stoneSpace', 0, 0, 4);
  editor.setMatrixCell('stoneSpace', 3, 1, .6);
  editor.queue({stoneGrain: {seed: 112}});
  assert.equal(frames.size, 1);
  assert.equal(editor.flush(), true);
  assert.equal(commits.length, 1);
  assert.equal(editor.plan().structure, structure);
  const index = editor.index();
  assert.deepEqual(index.byId.get('stoneShadow').value, [.15, before.nodes.find(node => node.id === 'stoneShadow').value[1], .25]);
  assert.equal(index.byId.get('stoneSpace').matrix[0], 4);
  assert.equal(index.byId.get('stoneSpace').matrix[13], .6);
  assert.equal(index.byId.get('stoneGrain').seed, 112);
  const after = editor.graph();
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), before);
  assert.equal(editor.redo(), true);
  assert.equal(editor.graph(), after);
  editor.setColorHex('stoneLight', '#538fb3');
  assert.equal(editor.flush(), true);
  assert.deepEqual(editor.index().byId.get('stoneLight').value, color.srgb('#538fb3').value);
  editor.setColorChannel('stoneLight', 1, 1.5);
  assert.equal(editor.flush(), true);
  assert.equal(editor.index().byId.get('stoneLight').value[1], 1.5);
  const accepted = editor.graph();
  editor.setColorChannel('stoneLight', 1, Infinity);
  assert.equal(editor.flush(), false);
  assert.equal(editor.graph(), accepted);
  editor.setMatrixCell('stoneSpace', 0, 0, 0);
  assert.equal(editor.flush(), false);
  assert.equal(editor.graph(), accepted);
});

test('blend input labels describe wrapped color materials and keep blend labels compact', t => {
  const {editor} = harness(t, session(COMPOSITION_EXAMPLES.lichen.create()));
  assert.equal(editor.surfaceLabel(editor.mask().blend.b), 'Color material · lichenMaterial');
  assert.equal(editor.surfaceLabel('lichenShell'), 'Blend lichenShell');
});

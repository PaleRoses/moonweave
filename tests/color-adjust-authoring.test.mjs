import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoot} from 'solid-js';
import {color, compileGraph, evaluateColor, materialGraph, named, patchGraph, scalar, serializeGraph, surface} from '../src/core.mjs';
import {
  addColorAdjustment, colorSources, connectColorAdjustment, exposeColorAdjustmentValue,
  isInlineColorValue, removeColorAdjustment,
} from '../lab/color-authoring.mts';
import {graphIndex, sourcesFor} from '../lab/composition.mts';
import {createEditor} from '../lab/editor.ts';

function sharedColor() {
  const ink = named('ink', color.srgb('#285b69'));
  const mixture = named('mixture', color.mix(ink, color.srgb('#c8aa70'), .4));
  return materialGraph(surface.mix(named('body', surface.material(ink)), surface.material(mixture), .3));
}

function addedAdjustment(graph) {
  return graph.nodes.findLast(node => node.kind === 'colorAdjust');
}

function editorFor(t, graph) {
  return createRoot(dispose => {
    let reject = false;
    const editor = createEditor({
      initial: {graph, baseline: graph, selectedPaint: null, selectedBlend: null, tab: 'compose', sourceOpen: false, sourceDraft: null},
      frames: {request() {return 1;}, cancel() {}},
      commit() {if (reject) throw new Error('Renderer rejected adjustment');}, invalidate() {},
    });
    t.after(() => {editor.dispose(); dispose();});
    return {editor, reject(value) {reject = value;}};
  });
}

test('adding an adjustment wraps every connected use and retains distinct live neutral parameters', () => {
  const original = sharedColor(), adjusted = addColorAdjustment(original, 'ink');
  const index = graphIndex(adjusted), node = addedAdjustment(adjusted);
  assert.equal(node.input, 'ink');
  assert.equal(index.byId.get('body').color, node.id);
  assert.equal(index.byId.get('mixture').a, node.id);
  assert.deepEqual(index.byId.get('ink'), graphIndex(original).byId.get('ink'));
  const ports = [node.lightness, node.chroma, node.hue];
  assert.equal(new Set(ports).size, 3);
  assert.deepEqual(ports.map(id => index.byId.get(id).kind), ['parameter', 'parameter', 'parameter']);
  assert.deepEqual(ports.map(id => index.byId.get(id).value), [0, 1, 0]);
  const input = evaluateColor(adjusted, 'ink').value, result = evaluateColor(adjusted, node.id).value;
  result.forEach((value, i) => assert.ok(Math.abs(value - input[i]) < 1e-6));
  const changed = patchGraph(adjusted, {[node.lightness]: {value: .1}, [node.chroma]: {value: .8}, [node.hue]: {value: 45}});
  assert.equal(compileGraph(changed).programKey, compileGraph(adjusted).programKey);
  assert.notDeepEqual(evaluateColor(changed, node.id).value, result);
});

test('stacked adjustments keep their own sources, offer acyclic sources and reject invalid connections', () => {
  const first = addColorAdjustment(sharedColor(), 'ink'), inner = addedAdjustment(first);
  const stacked = addColorAdjustment(first, inner.id), outer = addedAdjustment(stacked), before = serializeGraph(stacked);
  assert.equal(graphIndex(stacked).byId.get(inner.id).input, 'ink');
  assert.equal(outer.input, inner.id);
  const eligible = colorSources(stacked, inner.id).map(node => node.id);
  assert.ok(eligible.includes('ink'));
  assert.equal(eligible.includes(inner.id), false);
  assert.equal(eligible.includes(outer.id), false);
  assert.throws(() => connectColorAdjustment(stacked, inner.id, 'input', outer.id), /cycle|cyclic/i);
  assert.throws(() => connectColorAdjustment(stacked, inner.id, 'hue', 'ink'), /expects scalar/);
  assert.throws(() => connectColorAdjustment(stacked, inner.id, 'input', inner.hue), /expects color/);
  assert.equal(serializeGraph(stacked), before);
  assert.ok(sourcesFor(stacked, inner.id, 'scalar').some(node => node.id === inner.hue));
});

test('independent adjustment values preserve uniform values without editing other ports or shared uses', () => {
  const ink = named('ink', color.srgb('#4b6379'));
  const graph = materialGraph(surface.material(named('grade', color.adjust(ink))));
  const grade = graphIndex(graph).byId.get('grade'), oldHue = grade.hue;
  const exposed = exposeColorAdjustmentValue(graph, 'grade', 'lightness', -.12);
  const next = graphIndex(exposed).byId.get('grade'), index = graphIndex(exposed);
  assert.notEqual(next.lightness, grade.lightness);
  assert.equal(next.hue, oldHue);
  assert.equal(index.byId.get(oldHue).value, 0);
  assert.equal(index.byId.get(next.lightness).value, -.12);
  assert.equal(index.byId.get(next.lightness).kind, 'parameter');
  const shared = connectColorAdjustment(exposed, 'grade', 'hue', next.lightness);
  const independent = exposeColorAdjustmentValue(shared, 'grade', 'hue');
  const independentNode = graphIndex(independent).byId.get('grade');
  assert.notEqual(independentNode.hue, next.lightness);
  assert.equal(graphIndex(independent).byId.get(independentNode.hue).value, -.12);
  assert.equal(graphIndex(independent).byId.get(next.lightness).value, -.12);
});

test('removing an adjustment restores its source and prunes its controls while keeping imported unused work', () => {
  const base = sharedColor();
  const original = materialGraph({...base, nodes: [...base.nodes, {id: 'reserved', kind: 'parameter', value: .7}]});
  const first = addColorAdjustment(original, 'ink'), inner = addedAdjustment(first);
  const second = addColorAdjustment(first, inner.id), outer = addedAdjustment(second);
  const removed = removeColorAdjustment(second, inner.id), index = graphIndex(removed);
  assert.equal(index.byId.get(outer.id).input, 'ink');
  assert.equal(index.byId.has(inner.lightness), false);
  assert.equal(index.byId.has(inner.chroma), false);
  assert.equal(index.byId.has(inner.hue), false);
  assert.ok(index.byId.has('reserved'));
  assert.equal(serializeGraph(removeColorAdjustment(removed, outer.id)), serializeGraph(original));
});

test('inline adjustment values remain independently discoverable when also used for surface finish', () => {
  const value = named('sharedValue', scalar.parameter(.5));
  const graph = materialGraph(surface.channels(surface.material(named('grade', color.adjust(color.srgb('#b9af8d'), {
    chroma: value, hue: named('angle', scalar.parameter(12)),
  }))), {roughness: value}));
  assert.equal(isInlineColorValue(graph, 'angle'), true);
  assert.equal(isInlineColorValue(graph, 'sharedValue'), false);
  assert.equal(isInlineColorValue(graph, 'grade'), false);
});

test('editor adjustments preserve drafts, live program identity and exact undo across connection edits', t => {
  const original = sharedColor(), {editor} = editorFor(t, original);
  editor.openSource(); editor.editSource('unfinished source draft');
  assert.equal(editor.addColorAdjustment('ink'), true);
  const added = editor.graph(), adjustment = addedAdjustment(added), key = editor.plan().programKey;
  assert.ok(editor.surfaceControlIds().includes(adjustment.id));
  for (const id of [adjustment.lightness, adjustment.chroma, adjustment.hue]) assert.equal(editor.surfaceControlIds().includes(id), false);
  editor.queue({[adjustment.hue]: {value: 60}});
  assert.equal(editor.gestureEnd(), true);
  assert.equal(editor.plan().programKey, key);
  assert.equal(editor.sourceText(), 'unfinished source draft');
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), added);
  assert.equal(editor.redo(), true);
  assert.equal(editor.index().byId.get(adjustment.hue).value, 60);
  const edited = editor.graph();
  assert.equal(editor.setColorAdjustmentSource(adjustment.id, 'lightness', adjustment.hue), true);
  assert.equal(editor.exposeColorAdjustmentValue(adjustment.id, 'lightness'), true);
  const independent = editor.index().byId.get(adjustment.id).lightness;
  assert.notEqual(independent, adjustment.hue);
  assert.equal(editor.index().byId.get(independent).value, 60);
  assert.equal(editor.undo(), true);
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), edited);
  assert.equal(editor.removeColorAdjustment(adjustment.id), true);
  assert.equal(serializeGraph(editor.graph()), serializeGraph(original));
  assert.equal(editor.undo(), true);
  assert.equal(editor.graph(), edited);
  assert.equal(editor.sourceText(), 'unfinished source draft');
});

test('invalid source connections and renderer rejection leave accepted adjustment state and history intact', t => {
  const {editor, reject} = editorFor(t, sharedColor());
  editor.addColorAdjustment('ink');
  const accepted = editor.graph(), adjustment = addedAdjustment(accepted), undo = editor.undoLabel();
  assert.equal(editor.setColorAdjustmentSource(adjustment.id, 'input', adjustment.id), false);
  assert.equal(editor.graph(), accepted);
  assert.equal(editor.undoLabel(), undo);
  assert.equal(editor.notice().error, true);
  reject(true);
  assert.equal(editor.removeColorAdjustment(adjustment.id), false);
  assert.equal(editor.graph(), accepted);
  assert.equal(editor.undoLabel(), undo);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {composeSurface} from '../lab/composition.mts';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';
import {GRAPH_LIMITS, materialGraph, patchGraph} from '../src/core.mjs';
import {createSessionStore, decodeSession, encodeSession, SESSION_KEY} from '../lab/session.mts';

const snapshot = graph => ({graph, baseline: graph, selectedPaint: 'basePaint', selectedBlend: 'surface', tab: 'paint', sourceDraft: null, sourceOpen: false});
function harness() {
  const timers = new Map(), writes = [], statuses = [];
  let id = 0, saved = null, blocked = false;
  const store = createSessionStore({
    storage: () => ({getItem: () => saved, setItem(key, source) {
      if (blocked) throw new Error('Storage quota exceeded');
      writes.push({key, source}); saved = source;
    }}),
    request(fn) { timers.set(++id, fn); return id; }, cancel(id) {timers.delete(id);},
    status(value) {statuses.push(value);},
  });
  return {store, writes, statuses, timers, block(value) {blocked = value;}, seed(value) {saved = value;}};
}

test('saved sessions retain the accepted document, reset baseline and unapplied source separately', () => {
  const baseline = composeSurface({base: 'carapace', accent: 'horn'});
  const graph = patchGraph(baseline, {amount: {value: .2}});
  const session = {...snapshot(graph), baseline, sourceDraft: '{ unfinished', sourceOpen: true};
  const restored = decodeSession(encodeSession(session));
  assert.deepEqual(restored, session);
  assert.notEqual(restored.graph, restored.baseline);
  const unchanged = decodeSession(encodeSession(snapshot(graph)));
  assert.equal(unchanged.graph, unchanged.baseline);
});

test('saved mark edits store shared images once and restore their identity across the reset baseline', () => {
  const original = COMPOSITION_EXAMPLES.marks.create();
  const paint = original.nodes.find(node => node.kind === 'paint');
  const image = original.nodes.find(node => node.kind === 'image');
  const patched = patchGraph(original, {[image.id]: {resource: {...image.resource, data: image.resource.data.map(value => value * .5)}}});
  for (const baseline of [original, patched]) {
    const graph = patchGraph(baseline, {[paint.id]: {style: {roughness: .4}}});
    const session = {...snapshot(graph), baseline, sourceDraft: '{ unfinished', sourceOpen: true};
    const source = encodeSession(session), unedited = encodeSession({...session, graph: baseline});
    const stored = JSON.parse(source);
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.graph.nodes.filter(node => typeof node !== 'string').map(node => node.id), [paint.id]);
    assert.ok(source.length < unedited.length + 1500, 'A value edit stores one changed node, not another image atlas.');
    const restored = decodeSession(source), current = new Map(restored.graph.nodes.map(node => [node.id, node]));
    assert.deepEqual(restored, session);
    for (const node of restored.baseline.nodes) {
      if (node.id === paint.id) assert.notEqual(current.get(node.id), node);
      else assert.ok(current.get(node.id) === node, `${node.id} remains one owned node in both graphs.`);
      if (node.kind === 'image') {
        assert.ok(current.get(node.id).resource === node.resource, `${node.id} retains its resource identity.`);
        assert.ok(current.get(node.id).resource.data === node.resource.data, `${node.id} retains its sample array.`);
      }
    }
    assert.equal(encodeSession(restored), source, 'Reloading does not expand the compact session.');
  }
});

test('saved current graphs retain explicit node order, added definitions and changed values with existing IDs', () => {
  const baseline = composeSurface({accent: 'horn'});
  const edited = patchGraph(baseline, {amount: {value: .17}});
  const graph = materialGraph({...edited, nodes: [{id: 'unused', kind: 'parameter', value: .31}, ...edited.nodes.toReversed()]});
  const session = {...snapshot(graph), baseline};
  const stored = JSON.parse(encodeSession(session));
  assert.deepEqual(stored.graph.nodes.map(node => typeof node === 'string' ? node : node.id), graph.nodes.map(node => node.id));
  const restored = decodeSession(JSON.stringify(stored));
  assert.deepEqual(restored, session);
  assert.equal(restored.graph.nodes.find(node => node.id === 'amount').value, .17);
  assert.equal(restored.baseline.nodes.find(node => node.id === 'amount').value, .85);
});

test('version-one sessions remain readable and upgrade on the next save', () => {
  const baseline = composeSurface({accent: 'horn'});
  for (const graph of [baseline, patchGraph(baseline, {amount: {value: .23}})]) {
    const session = {...snapshot(graph), baseline, sourceDraft: '', sourceOpen: true};
    const previous = JSON.stringify({version: 1, ...session, baseline: baseline === graph ? null : baseline});
    const restored = decodeSession(previous);
    assert.deepEqual(restored, session);
    assert.equal(JSON.parse(encodeSession(restored)).version, 2);
    if (baseline === graph) assert.equal(restored.baseline, restored.graph);
  }
});

test('edited version-one mark sessions migrate to one shared baseline without losing paint values or drafts', () => {
  const baseline = COMPOSITION_EXAMPLES.marks.create();
  const paint = baseline.nodes.find(node => node.kind === 'paint');
  const graph = patchGraph(baseline, {[paint.id]: {style: {roughness: .4}}});
  const session = {...snapshot(graph), baseline, sourceDraft: '{ unfinished legacy paint', sourceOpen: true};
  const previous = JSON.stringify({version: 1, ...session});
  const restored = decodeSession(previous), current = new Map(restored.graph.nodes.map(node => [node.id, node]));
  assert.deepEqual(restored, session);
  for (const node of restored.baseline.nodes) {
    if (node.id === paint.id) {
      assert.notEqual(current.get(node.id), node);
      assert.equal(current.get(node.id).style.roughness, .4);
      assert.equal(node.style.roughness, paint.style.roughness);
    } else assert.ok(current.get(node.id) === node, `${node.id} borrows its equal same-ID baseline node.`);
    if (node.kind === 'image') {
      assert.ok(current.get(node.id).resource === node.resource);
      assert.ok(current.get(node.id).resource.data === node.resource.data);
    }
  }
  const upgraded = encodeSession(restored);
  assert.equal(upgraded, encodeSession(session), 'A migrated save is as compact as a newly authored shared session.');
  assert.ok(upgraded.length < previous.length * .51);
  assert.equal(encodeSession(decodeSession(upgraded)), upgraded);
});

test('legacy sharing is restricted to same-ID records and does not intern separately authored version-two nodes', () => {
  const base = composeSurface({accent: 'horn'});
  const baseline = materialGraph({...base, nodes: [...base.nodes,
    {id: 'first', kind: 'parameter', value: .3}, {id: 'second', kind: 'parameter', value: .3},
  ]});
  const graph = materialGraph(JSON.parse(JSON.stringify(baseline)));
  const session = {...snapshot(graph), baseline};
  const legacy = decodeSession(JSON.stringify({version: 1, ...session}));
  const current = new Map(legacy.graph.nodes.map(node => [node.id, node]));
  const original = new Map(legacy.baseline.nodes.map(node => [node.id, node]));
  assert.equal(current.get('first'), original.get('first'));
  assert.equal(current.get('second'), original.get('second'));
  assert.notEqual(current.get('first'), current.get('second'));
  assert.notEqual(legacy.graph, legacy.baseline, 'Distinct documents retain their edited-state identity.');
  const modern = decodeSession(encodeSession(session));
  assert.deepEqual(modern, session);
  for (const node of modern.graph.nodes) {
    assert.notEqual(node, modern.baseline.nodes.find(original => original.id === node.id));
  }
});

test('session references reject unknown IDs, duplicate nodes and invalid graphs before acceptance', () => {
  const baseline = composeSurface({accent: 'horn'}), graph = patchGraph(baseline, {amount: {value: .2}});
  const stored = JSON.parse(encodeSession({...snapshot(graph), baseline}));
  const invalid = [
    {...stored.graph, nodes: ['missing']},
    {...stored.graph, nodes: [...stored.graph.nodes, stored.graph.nodes[0]]},
    {...stored.graph, nodes: Array(GRAPH_LIMITS.nodes + 1).fill(stored.graph.nodes[0])},
    {...stored.graph, output: 'missing'},
    {...stored.graph, version: 999},
    {...stored.graph, nodes: [false]},
  ];
  let accepted = 0;
  for (const current of invalid) {
    assert.throws(() => decodeSession(JSON.stringify({...stored, graph: current}), () => { accepted++; }));
  }
  assert.equal(accepted, 0);
});

test('autosave coalesces edits without touching storage until the save boundary', () => {
  const {store, writes, timers} = harness();
  const initial = composeSurface({accent: 'horn'});
  for (let i = 0; i < 60; i++) store.schedule(snapshot(patchGraph(initial, {amount: {value: i / 100}})));
  assert.equal(writes.length, 0);
  assert.equal(timers.size, 1);
  timers.values().next().value();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, SESSION_KEY);
  assert.equal(decodeSession(writes[0].source).graph.nodes.find(node => node.id === 'amount').value, .59);
  assert.equal(timers.size, 0);
  store.flush();
  assert.equal(writes.length, 1);
});

test('storage failures keep the pending session retryable without losing the in-memory document', () => {
  const {store, writes, statuses, block} = harness();
  const session = snapshot(composeSurface());
  block(true); store.schedule(session);
  assert.equal(store.flush(), false);
  assert.equal(statuses.at(-1), 'unavailable');
  assert.equal(writes.length, 0);
  block(false);
  assert.equal(store.flush(), true);
  assert.equal(statuses.at(-1), 'saved');
  assert.deepEqual(store.load(), session);
});

test('invalid or incompatible stored documents do not overwrite storage on load', () => {
  const {store, writes, statuses, seed} = harness();
  for (const source of ['{', '{"version":2}', '{"version":1,"graph":{}}']) {
    seed(source);
    assert.equal(store.load(), undefined);
    assert.equal(statuses.at(-1), 'unavailable');
  }
  assert.equal(writes.length, 0);
});

test('restoration checks both graph and reset baseline against the host renderer budget', () => {
  const baseline = composeSurface({accent: 'horn'}), graph = patchGraph(baseline, {amount: {value: .1}});
  const source = encodeSession({...snapshot(graph), baseline});
  const seen = [];
  assert.throws(() => decodeSession(source, graph => {
    seen.push(graph);
    if (seen.length === 2) throw new Error('Unsupported reset baseline');
  }), /Unsupported reset baseline/);
  assert.equal(seen.length, 2);
});

test('disposing flushes one pending save, cancels its timer and ignores future schedules', () => {
  const {store, writes, timers} = harness();
  const session = snapshot(composeSurface());
  store.schedule(session); store.dispose();
  assert.equal(writes.length, 1);
  assert.equal(timers.size, 0);
  store.schedule(session); store.dispose();
  assert.equal(writes.length, 1);
  assert.equal(timers.size, 0);
});

test('a color-only surface persists a null paint selection without inventing a paint', () => {
  const graph = COMPOSITION_EXAMPLES.stone.create();
  const session = {...snapshot(graph), selectedPaint: null, selectedBlend: null, sourceDraft: '{ draft'};
  const restored = decodeSession(encodeSession(session));
  assert.equal(restored.selectedPaint, null);
  assert.equal(restored.selectedBlend, null);
  assert.deepEqual(restored, session);
});

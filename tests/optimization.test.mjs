import test from 'node:test';
import assert from 'node:assert/strict';
import {surface, color, scalar, image, named, materialGraph, patchGraph, compileGraph} from '../src/core.mjs';
import {createOptimizationJob, verifyOptimization, applyOptimization} from '../src/optimize.mjs';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';

function fixture() {
  const base = named('substrate', surface.paint('carapace'));
  const resource = named('paintedFinish', image.generate({width: 8, height: 4, channels: 1}, (u, v) => u * v));
  const old = named('oldFinish', scalar.image(resource, {filter: 'anisotropic'}));
  const finish = named('creatureFinish', scalar.parameter(.42));
  const ink = named('ink', color.srgb('#234c82'));
  const weight = named('coverage', scalar.parameter(.6));
  const height = named('height', scalar.multiply(.005, scalar.noise({seed: 7})));
  const decorated = s => surface.bump(surface.coat(s, ink, weight), height);
  const original = materialGraph(surface.channels(decorated(surface.channels(base, {roughness: old})), {roughness: finish}));
  const target = materialGraph(surface.channels(decorated(base), {roughness: finish}));
  return {original, target, candidate: createOptimizationJob(target), old, finish, base, decorated};
}

test('effect export is compact, typed, immutable and contains no image payloads or editable values', () => {
  const {original} = fixture(), job = createOptimizationJob(original);
  assert.equal(job.rules.length, 24);
  assert(Object.isFrozen(job)); assert(Object.isFrozen(job.terms));
  assert(job.terms.some(term => term.source === 'oldFinish'));
  assert(!JSON.stringify(job).includes('paintedFinish'));
  assert(!JSON.stringify(job).includes('0.42'));
  assert.equal(verifyOptimization(original, job).equivalent, true);
});

test('exact finish elimination removes runtime sampling while preserving all authored IDs', () => {
  const {original, candidate} = fixture(), result = applyOptimization(original, candidate);
  assert.equal(result.accepted, true);
  assert.equal(result.before.textureReads, 68);
  assert.equal(result.after.textureReads, 4);
  assert.equal(result.before.proceduralSamples, result.after.proceduralSamples);
  for (const node of original.nodes) assert.deepEqual(result.graph.nodes.find(value => value.id === node.id), node);
  assert(!compileGraph(result.graph).nodes.some(node => node.kind === 'image'));
  assert(result.graph.nodes.some(node => node.id === 'paintedFinish'));
  const edits = {creatureFinish: {value: .91}, coverage: {value: .18}, paintedFinish: {
    resource: {width: 2, height: 1, channels: 1, data: [.9, .2]},
  }};
  const patched = patchGraph(original, edits);
  assert.equal(verifyOptimization(patched, candidate).equivalent, true);
  const updated = patchGraph(result.graph, edits);
  assert.equal(compileGraph(updated).cost.textureReads, 4);
  assert.equal(updated.nodes.find(node => node.id === 'creatureFinish').value, .91);
  assert.equal(applyOptimization(result.graph, createOptimizationJob(result.graph)).graph, result.graph);
});

test('an independently shared branch prevents global elimination of its old finish', () => {
  const {original, base, old, finish, decorated} = fixture();
  const local = surface.channels(base, {roughness: old});
  const blend = named('branchWeight', scalar.parameter(.5));
  const shared = materialGraph(surface.mix(surface.channels(decorated(local), {roughness: finish}), local, blend));
  const valid = createOptimizationJob(materialGraph(surface.mix(surface.channels(decorated(base), {roughness: finish}), local, blend)));
  assert.equal(verifyOptimization(shared, valid).equivalent, true);
  const result = applyOptimization(shared, valid);
  assert.equal(result.before.textureReads, 68);
  assert.equal(result.after.textureReads, 68);
  const invalid = createOptimizationJob(materialGraph(surface.mix(surface.channels(decorated(base), {roughness: finish}), base, blend)));
  assert.equal(verifyOptimization(shared, invalid).equivalent, false);
  assert.throws(() => applyOptimization(shared, invalid), /roughness/);
  assert(original.nodes.length > 0);
});

test('atom identity and per-component ordering are part of equivalence', () => {
  const {original, candidate} = fixture();
  const changed = structuredClone(candidate);
  changed.terms.find(node => node.source === 'creatureFinish').source = 'oldFinish';
  assert.deepEqual(verifyOptimization(original, changed).changed, ['roughness']);
  const a = named('a', scalar.parameter(.5)), b = named('b', scalar.parameter(.5));
  const base = named('base', surface.material(color.srgb('#eeddcc')));
  const graph = materialGraph(surface.channels(base, {roughness: a, metalness: b}));
  const merged = structuredClone(createOptimizationJob(graph));
  merged.terms.find(node => node.source === 'b').source = 'a';
  assert.deepEqual(verifyOptimization(graph, merged).changed, ['metalness']);
  const h = named('h', scalar.axis('x')), k = named('k', scalar.parameter(2));
  const first = materialGraph(surface.relief(surface.bump(base, h), k));
  const swapped = createOptimizationJob(surface.bump(surface.relief(base, k), h));
  assert.deepEqual(verifyOptimization(first, swapped).changed, ['slope']);
});

test('candidate decoding rejects invented sources, wrong sorts, duplicate IDs and forward references', () => {
  const {original} = fixture();
  const mutate = fn => {const job = structuredClone(createOptimizationJob(original)); fn(job); return job;};
  assert.throws(() => verifyOptimization(original, mutate(job => job.terms[0].source = 'missing')), /identity/);
  assert.throws(() => verifyOptimization(original, mutate(job => job.terms[0].source = {toString: () => 'substrate'})), /node ID/);
  assert.throws(() => verifyOptimization(original, mutate(job => job.terms[1].id = job.terms[0].id)), /Duplicate/);
  assert.throws(() => verifyOptimization(original, mutate(job => job.terms.find(node => node.op === 'Coat').args[1] = job.terms[0].id)), /color term/);
  assert.throws(() => verifyOptimization(original, mutate(job => job.terms.find(node => node.args).args[0] = job.output)), /earlier/);
  assert.throws(() => verifyOptimization(original, mutate(job => delete job.terms.find(node => node.args).args[1])), /node ID/);
  assert.throws(() => verifyOptimization(original, mutate(job => delete job.terms[1])), /optimization term/);
  assert.throws(() => verifyOptimization(original, mutate(job => job.ruleset = 'algebra-over-reals')), /Unsupported/);
});

test('source document limits keep the authored graph and report a rejected extraction', () => {
  const {original, candidate} = fixture();
  const nodes = [...original.nodes];
  while (nodes.length < 256) nodes.push({id: `unused${nodes.length}`, kind: 'parameter', value: .5});
  const graph = materialGraph({...original, nodes});
  const result = applyOptimization(graph, candidate);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'graph-limit');
  assert.equal(result.graph, graph);
  assert.equal(result.proof.equivalent, true);
});

test('an equivalent extraction that duplicates a shared coat is rejected by compiled DAG cost', () => {
  const base = named('base', surface.material(color.srgb('#cc8866')));
  const ink = named('ink', color.srgb('#123456')), mask = named('mask', scalar.parameter(.4));
  const x = named('x', scalar.parameter(.2)), y = named('y', scalar.parameter(.7));
  const blend = named('blend', scalar.parameter(.5));
  const coat = surface.coat(base, ink, mask);
  const original = materialGraph(surface.mix(surface.channels(coat, {roughness: x}), surface.channels(coat, {roughness: y}), blend));
  const candidate = createOptimizationJob(surface.mix(
    surface.coat(surface.channels(base, {roughness: x}), ink, mask),
    surface.coat(surface.channels(base, {roughness: y}), ink, mask), blend));
  const result = applyOptimization(original, candidate);
  assert.equal(result.proof.equivalent, true);
  assert.equal(result.reason, 'cost-regression');
  assert.equal(result.after.liveNodes, result.before.liveNodes + 1);
  assert.equal(result.graph, original);
});

test('all gallery graphs retain their exact original object when no compiled cost improves', () => {
  for (const [name, example] of Object.entries(COMPOSITION_EXAMPLES)) {
    const graph = materialGraph(example.create());
    const result = applyOptimization(graph, createOptimizationJob(graph));
    assert.equal(result.graph, graph, name);
    assert.equal(result.accepted, false, name);
    assert.equal(result.reason, 'no-improvement', name);
    assert.deepEqual(result.after, result.before, name);
  }
});

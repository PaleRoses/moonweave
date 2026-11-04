/** Real egglog receipts, compiled DAG costs and finite observational evidence. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import * as core from '../src/core.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';
import {compareGraphs} from './compare-graphs.mjs';
import {optimizationFixtures, optimizationContexts} from './optimization-fixtures.mjs';
import {optimizeGraph} from './optimize-graph.mjs';

const [baselinePath, outputPath = 'validation/optimization57/results'] = process.argv.slice(2);
if (!baselinePath) throw new Error('Usage: node tools/measure-optimization.mjs <baseline-directory> [output-directory]');
const baseline = resolve(baselinePath), output = resolve(outputPath);
const old = await import(pathToFileURL(resolve(baseline, 'src/core.mjs')));
const oldShader = (await import(pathToFileURL(resolve(baseline, 'src/three/shader.mjs')))).generateSurfaceShader;
const oldExamples = (await import(pathToFileURL(resolve(baseline, 'lab/composition.mts')))).COMPOSITION_EXAMPLES;
const provenance = JSON.parse(readFileSync(resolve(baseline, 'provenance.json'), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const shaderText = (graph, api = core, generate = generateSurfaceShader) => {
  const generated = generate(api.compileGraph(graph));
  return generated.declarations + generated.evaluate;
};
const write = (name, data) => writeFileSync(resolve(output, name), `${JSON.stringify(data, null, 2)}\n`);
mkdirSync(output, {recursive: true});

function metrics(graph, api = core, generate = generateSurfaceShader) {
  const plan = api.compileGraph(graph), json = api.serializeGraph(graph), shader = shaderText(graph, api, generate);
  const images = new Set(plan.nodes.filter(node => node.kind === 'image').map(node => node.id));
  return {authoredNodes: graph.nodes.length, liveNodes: plan.nodes.length,
    graphJSONBytes: Buffer.byteLength(json), generatedGLSLBytes: Buffer.byteLength(shader),
    programKeyBytes: Buffer.byteLength(plan.programKey),
    imageSources: plan.bindings.filter(binding => images.has(binding.nodeId)).map(binding => binding.sourceId).sort(),
    cost: plan.cost, graphSHA256: sha256(json), compiledNodesSHA256: sha256(JSON.stringify(plan.nodes)),
    programKeySHA256: sha256(plan.programKey), generatedGLSLSHA256: sha256(shader)};
}

const gallery = {};
for (const [name, example] of Object.entries(oldExamples)) {
  assert(COMPOSITION_EXAMPLES[name], `Missing gallery example ${name}.`);
  const before = example.create(), after = COMPOSITION_EXAMPLES[name].create();
  const baselineMetrics = metrics(before, old, oldShader), currentMetrics = metrics(after);
  assert.equal(core.serializeGraph(after), old.serializeGraph(before), `${name}: authored graph changed.`);
  assert.deepEqual(core.compileGraph(after).nodes, old.compileGraph(before).nodes, `${name}: compiled nodes changed.`);
  assert.equal(core.compileGraph(after).programKey, old.compileGraph(before).programKey, `${name}: program key changed.`);
  assert.equal(shaderText(after), shaderText(before, old, oldShader), `${name}: generated shader changed.`);
  gallery[name] = {sameGraph: true, sameCompiledNodes: true, sameProgramKey: true, sameShader: true,
    baseline: baselineMetrics, current: currentMetrics};
}
assert.equal(Object.keys(gallery).length, 15);

const contexts = optimizationContexts(), workloads = {}, timings = {}, cases = [];
for (const fixture of optimizationFixtures()) {
  const {id, label, graph, patches, paint, observations, expected} = fixture;
  const started = performance.now();
  const {job, candidate, result} = await optimizeGraph(graph, {
    python: process.env.MOONWEAVE_EGGLOG_PYTHON || 'python3', iterations: 12, rows: 50_000, timeoutMs: 60_000,
  });
  timings[id] = performance.now() - started;
  assert.equal(candidate.receipt.engine, 'egglog');
  assert.equal(candidate.receipt.version, '14.0.0');
  assert.equal(result.proof.equivalent, true);
  if (expected.strictImprovement) assert.equal(result.accepted, true, `${id}: expected a strict improvement.`);
  const before = metrics(graph), after = metrics(result.graph);
  assert.equal(after.imageSources.includes('roughAtlas'), expected.imageRetained, `${id}: resource liveness changed incorrectly.`);
  if (id === 'independent') assert.equal(before.cost.textureReads - after.cost.textureReads, 64);
  if (id === 'shared-image') assert.equal(after.cost.textureReads, before.cost.textureReads);
  const retained = new Map(result.graph.nodes.map(node => [node.id, node]));
  for (const node of graph.nodes) assert.deepEqual(retained.get(node.id), node, `${id}: authored definition ${node.id} changed.`);
  const outputComparison = compareGraphs(graph, result.graph, {contexts, patches, paint});
  const retainedViews = compareGraphs(graph, result.graph, {contexts, patches, observations, paint});
  assert.equal(outputComparison.equal, true, `${id}: output simulation found a counterexample.`);
  assert.equal(retainedViews.equal, true, `${id}: a named authored view changed.`);
  const revisions = patches.map((patch, index) => {
    const original = core.compileGraph(core.patchGraph(graph, patch));
    const optimized = core.compileGraph(core.patchGraph(result.graph, patch));
    assert.equal(original.programKey, core.compileGraph(graph).programKey);
    assert.equal(optimized.programKey, core.compileGraph(result.graph).programKey);
    return {index, sameOriginalProgram: true, sameOptimizedProgram: true,
      originalCost: original.cost, optimizedCost: optimized.cost};
  });
  workloads[id] = {label, accepted: result.accepted, reason: result.reason, proof: result.proof,
    before, after, sourceDefinitionsRetained: graph.nodes.length,
    compiledCost: {before: result.before, after: result.after},
    engine: candidate.receipt, outputComparison, retainedViews, revisions};
  write(`${id}-before.json`, graph);
  write(`${id}-after.json`, result.graph);
  write(`${id}-job.json`, job);
  write(`${id}-candidate.json`, candidate);
  write(`${id}-patches.json`, patches);
  cases.push({id, label, before: `${id}-before.json`, after: `${id}-after.json`, patches: `${id}-patches.json`});
}
const report = {
  version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  baseline: provenance,
  accounting: 'Compiled DAG node counts, uniform components, static texture-read ceilings and generated source bytes. These are not GPU timings, driver allocation or JavaScript heap measurements. Egglog extraction cost is a search heuristic; acceptance uses the compiled DAG cost vector.',
  evidence: 'Independent exact symbolic surface-product certificate plus finite CPU field and unlit record observations. Opaque paint records exercise surface laws without evaluating facets or lighting. Numerical matches are not universal equivalence proofs.',
  gallery, workloads,
  totals: {galleryExamples: Object.keys(gallery).length, workloads: Object.keys(workloads).length,
    contextsPerRevision: contexts.length,
    observedSamples: Object.values(workloads).reduce((sum, value) => sum + value.outputComparison.samples + value.retainedViews.samples, 0),
    observedComponents: Object.values(workloads).reduce((sum, value) => sum + value.outputComparison.components + value.retainedViews.components, 0)},
  timings: {unit: 'milliseconds', scope: 'Offline optimization wall time including Python startup, extraction and bridge checks; no rendering.', workloads: timings},
};
write('cases.json', {version: 1, cases});
write('report.json', report);
console.log(JSON.stringify({output, totals: report.totals, workloads: Object.fromEntries(Object.entries(workloads).map(([id, value]) =>
  [id, {accepted: value.accepted, reason: value.reason, before: value.compiledCost.before, after: value.compiledCost.after,
    engine: {rounds: value.engine.rounds, stopReason: value.engine.stopReason, initialCost: value.engine.initialCost, cost: value.engine.cost}}]))}, null, 2));

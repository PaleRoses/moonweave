import {evidencePath} from './evidence-path.mjs';
/** Paired graph-wide CPU preparation and multi-output sampling measurements. */
import assert from 'node:assert/strict';
import {readFile, readdir, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node --expose-gc tools/benchmark-roots.mjs <v59-baseline-directory> [receipt.json]');
const runs = 7, preparationIterations = 100, samplingIterations = 2000, warmupOperations = 100;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let observed;

async function load(directory) {
  const module = path => import(pathToFileURL(resolve(directory, path)).href);
  const [core, fields, evaluator, pkg] = await Promise.all([
    module('src/core.mjs'), module('src/core/field-evaluate.mts'), module('src/core/evaluate.mts'),
    readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const sourceSHA256 = {};
  for (const path of (await readdir(resolve(directory, 'src'), {recursive: true})).sort()) {
    if (!/\.(mjs|mts)$/.test(path) || path.endsWith('.d.mts')) continue;
    sourceSHA256[`src/${path}`] = createHash('sha256').update(await readFile(resolve(directory, 'src', path))).digest('hex');
  }
  return {core, fields, evaluator, version: pkg.version, sourceSHA256};
}

function fixtures(core) {
  const {scalar, color, domain, image, surface, named} = core;
  let expression = named('step0', scalar.noise({seed: 7}));
  const roots = {step0: {id: 'step0', sort: 'scalar'}};
  for (let i = 1; i <= 40; i++) {
    const id = `step${i}`;
    roots[id] = {id, sort: 'scalar'};
    expression = named(id, scalar.add(expression, scalar.parameter(i / 100)));
  }
  const frame = named('frame', domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .2, -.1, 0, 1]));
  const atlas = image.generate({width: 16, height: 16, channels: 3}, (u, v, x, y) =>
    [u, v, .5 + .5 * Math.sin(x * .7) * Math.cos(y * .4)]);
  const options = {domain: frame, address: 'repeat', filter: 'anisotropic'};
  const red = named('red', scalar.image(atlas, {...options, channel: 'r'}));
  const green = named('green', scalar.image(atlas, {...options, channel: 'g'}));
  const blue = named('blue', scalar.image(atlas, {...options, channel: 'b'}));
  const pigment = named('pigment', color.image(atlas, options));
  const material = surface.bump(surface.channels(surface.material(pigment), {roughness: red, metalness: green}), blue);
  return {
    overlapping41: {description: 'Forty-one named prefixes of one editable noise field: 81 authored nodes, sampled together.', expression, roots},
    singleRoot81: {description: 'The same 81-node graph sampled through the original single-root API; control for ordinary sampling overhead.',
      expression, roots: {result: {id: 'step40', sort: 'scalar'}}, single: true},
    mixedImageOutputs: {description: 'RGB scalar projections, color and domain outputs share one anisotropic image reconstruction.',
      expression: material, roots: {red: {id: 'red', sort: 'scalar'}, green: {id: 'green', sort: 'scalar'},
        blue: {id: 'blue', sort: 'scalar'}, pigment: {id: 'pigment', sort: 'color'}, frame: {id: 'frame', sort: 'domain'}}},
  };
}

const contexts = Array.from({length: 45}, (_, i) => ({
  position: [Math.sin(i * .31) * .8, Math.cos(i * .43) * .7, Math.sin(i * .17) * .6],
  normal: [0, 1, 0], dx: [.3, .07, -.1], dy: [-.03, .4, .1],
  normalDx: [.01, 0, .02], normalDy: [-.02, 0, .01],
  footprint: {dx: [.11, .03, 0], dy: [.02, .09, 0]},
}));

function prepare(implementation, graph, roots, shared) {
  const ids = Object.values(roots).map(root => root.id);
  if (shared) return implementation.evaluator.prepareFieldPoints(graph, ids);
  const prepared = ids.map(id => ({id, ...implementation.evaluator.prepareFieldPoint(graph, id)}));
  return {roots: prepared, sourceNodes: prepared.reduce((sum, item) => sum + item.sourceNodes, 0),
    preparedNodes: prepared.reduce((sum, item) => sum + item.preparedNodes, 0),
    sharedNodes: prepared.reduce((sum, item) => sum + item.sharedNodes, 0)};
}

function evidence(implementation, graph, roots, shared) {
  const prepared = prepare(implementation, graph, roots, shared);
  let memoEntries = 0;
  const state = {base: implementation.fields.sampleDomain(contexts[0]), values: new Map()};
  for (const root of prepared.roots) {
    if (shared) root.point(state);
    else {
      const local = {base: state.base, values: new Map()};
      root.point(local);
      memoEntries += local.values.size;
    }
  }
  if (shared) memoEntries = state.values.size;
  return {sourceNodeVisits: prepared.sourceNodes, preparedNodes: prepared.preparedNodes,
    structuralDuplicates: prepared.sharedNodes, memoEntriesPerOutputSet: memoEntries};
}

function sampler(implementation, graph, fixture, shared) {
  if (fixture.single) return implementation.core.createFieldSampler(graph);
  if (shared) return implementation.core.createFieldSampler(graph, fixture.roots);
  const entries = Object.entries(fixture.roots), evaluate = {
    scalar: implementation.core.evaluateScalar, color: implementation.core.evaluateColor,
    domain: implementation.core.evaluateDomain,
  };
  return context => Object.freeze(Object.fromEntries(entries.map(([name, root]) =>
    [name, evaluate[root.sort](graph, root.id, context)])));
}

function paired(baseline, current, iterations) {
  const operations = {baseline, current}, samples = {baseline: [], current: []};
  for (const operation of Object.values(operations)) for (let i = 0; i < warmupOperations; i++) observed = operation(i);
  for (let run = 0; run < runs; run++) {
    for (const name of run % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      globalThis.gc?.();
      const start = performance.now(), operation = operations[name];
      for (let i = 0; i < iterations; i++) observed = operation(i);
      samples[name].push((performance.now() - start) * 1000 / iterations);
    }
  }
  const baselineMedian = median(samples.baseline), currentMedian = median(samples.current);
  return {baselineMicroseconds: baselineMedian, currentMicroseconds: currentMedian,
    speedup: baselineMedian / currentMedian, samplesMicroseconds: samples};
}

const [baseline, current] = await Promise.all([load(resolve(process.argv[2])), load(root)]);
const cases = {};
for (const [name, fixture] of Object.entries(fixtures(baseline.core))) {
  const json = baseline.core.serializeGraph(baseline.core.expressionGraph(fixture.expression));
  const oldGraph = baseline.core.parseExpressionGraph(json), newGraph = current.core.parseExpressionGraph(json);
  const before = evidence(baseline, oldGraph, fixture.roots, false), after = evidence(current, newGraph, fixture.roots, true);
  const oldSample = sampler(baseline, oldGraph, fixture, false), newSample = sampler(current, newGraph, fixture, true);
  for (const context of contexts) assert.deepEqual(newSample(context), oldSample(context));
  cases[name] = {description: fixture.description, graphSHA256: createHash('sha256').update(json).digest('hex'),
    authoredNodes: oldGraph.nodes.length, outputs: Object.keys(fixture.roots).length,
    baseline: before, current: after, exactSampleContexts: contexts.length,
    importAndPrepare: paired(
      () => prepare(baseline, baseline.core.parseExpressionGraph(json), fixture.roots, false),
      () => prepare(current, current.core.parseExpressionGraph(json), fixture.roots, true), preparationIterations),
    samplePrepared: paired(i => oldSample(contexts[i % contexts.length]), i => newSample(contexts[i % contexts.length]), samplingIterations),
  };
}
const result = {
  version: current.version,
  environment: {node: process.version, platform: process.platform, architecture: process.arch},
  method: {runs, preparationIterations, samplingIterations, warmupOperations,
    order: 'Alternating baseline/current batches.', explicitGC: !!globalThis.gc},
  scope: 'CPU only. Preparation includes importing the same v1 JSON and preparing the requested roots. Baseline prepares each root separately; current incrementally prepares the union. Sampling uses public APIs: baseline evaluates each selected root separately; current requests one output record with one shared sample memo. Single-root control uses createFieldSampler(graph) in both implementations. Exact values and differentials checked in 45 contexts. Excludes GPU, browser, shader compilation and rendering.',
  baseline: {version: baseline.version, sourceSHA256: baseline.sourceSHA256},
  current: {version: current.version, sourceSHA256: current.sourceSHA256}, cases,
};
const output = resolve(root, process.argv[3] ?? evidencePath('roots.json'));
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({output, cases: Object.fromEntries(Object.entries(cases).map(([name, item]) => [name, {
  nodes: [item.baseline.preparedNodes, item.current.preparedNodes],
  memoEntries: [item.baseline.memoEntriesPerOutputSet, item.current.memoEntriesPerOutputSet],
  sampleMicroseconds: [item.samplePrepared.baselineMicroseconds, item.samplePrepared.currentMicroseconds],
  sampleSpeedup: item.samplePrepared.speedup,
  importAndPrepareMicroseconds: [item.importAndPrepare.baselineMicroseconds, item.importAndPrepare.currentMicroseconds],
}]))}, null, 2));
void observed;

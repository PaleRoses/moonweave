import {evidencePath} from './evidence-path.mjs';
/** Paired CPU preparation/sampling against an immutable source checkout. */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile, readdir, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node --expose-gc tools/benchmark-sharing.mjs <baseline-directory> [receipt.json]');
const runs = 7, samplingIterations = 4000, preparationIterations = 100;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let observed;

async function load(directory, current = false) {
  const module = path => import(pathToFileURL(resolve(directory, path)).href);
  const [core, fields, evaluator, pkg] = await Promise.all([
    module('src/core.mjs'), module('src/core/field-evaluate.mts'),
    existsSync(resolve(directory, 'src/core/evaluate.mts')) ? module('src/core/evaluate.mts') : null,
    readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  if (current) assert.equal(core.createFieldSampler, evaluator.createFieldSampler);
  const sourceSHA256 = {};
  for (const path of (await readdir(resolve(directory, 'src'), {recursive: true})).sort()) {
    if (!/\.(mjs|mts)$/.test(path) || path.endsWith('.d.mts')) continue;
    sourceSHA256[`src/${path}`] = createHash('sha256').update(await readFile(resolve(directory, 'src', path))).digest('hex');
  }
  return {core, fields, evaluator, version: pkg.version, sourceSHA256};
}

function sum(scalar, inputs) {
  let nodes = inputs;
  while (nodes.length > 1) {
    const next = [];
    for (let index = 0; index < nodes.length; index += 2) {
      next.push(index + 1 < nodes.length ? scalar.add(nodes[index], nodes[index + 1]) : nodes[index]);
    }
    nodes = next;
  }
  return nodes[0];
}

function fixtures(core) {
  const {scalar, color, image, domain, named} = core;
  const gain = named('gain', scalar.parameter(.7)), offset = named('offset', scalar.parameter(.2));
  const pair = () => scalar.multiply(scalar.axis('x'), gain);
  const branch = () => scalar.multiply(
    scalar.complement(scalar.multiply(scalar.axis('x'), gain)), scalar.add(scalar.axis('y'), offset),
  );
  const frame = domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .3, .2, 0, 1]);
  const atlas = image.generate({width: 16, height: 16, channels: 1}, (u, v, x, y) => .5 + .5 * Math.sin(x * .7) * Math.cos(y * .4));
  const reader = () => scalar.multiply(scalar.image(atlas, {domain: frame, address: 'repeat', filter: 'anisotropic'}), gain);
  const ink = color.linear([.2, .3, .7]);
  const shade = () => color.adjust(ink, {lightness: .04, chroma: .8, hue: 19});
  return {
    duplicatePair: {description: 'Two separately authored x * gain branches with one shared editable gain.', expression: scalar.add(pair(), pair())},
    duplicateScalarTree16: {description: 'Sixteen independently authored copies of one scalar branch in a balanced sum.', expression: sum(scalar, Array.from({length: 16}, branch))},
    independentParameters32: {description: 'A balanced sum of 32 distinct editable parameters; no eligible duplicate structure.', expression: sum(scalar, Array.from({length: 32}, (_, i) => scalar.parameter((i + 1) / 1024)))},
    filteredImageReaders16: {description: 'Sixteen scalar image projections/products; the preexisting image reconstruction cache already shares filtering.', expression: sum(scalar, Array.from({length: 16}, reader))},
    identitySensitiveColor: {description: 'Two equal color adjustments mixed in Oklab; color identities and conversion stay separate, scalar constants share.', expression: color.mix(shade(), shade(), .35, {space: 'oklab'})},
  };
}

const contexts = Array.from({length: 45}, (_, i) => ({
  position: [Math.sin(i * .31) * .8, Math.cos(i * .43) * .7, Math.sin(i * .17) * .6],
  normal: [0, 1, 0], dx: [.3, .07, -.1], dy: [-.03, .4, .1],
  normalDx: [.01, 0, .02], normalDy: [-.02, 0, .01],
  footprint: {dx: [.11, .03, 0], dy: [.02, .09, 0]},
}));

function preparation(implementation, graph) {
  let prepared;
  if (implementation.evaluator) prepared = implementation.evaluator.prepareFieldPoint(graph);
  else {
    let nodes = 0;
    const algebra = Object.fromEntries(Object.entries(implementation.fields.fieldAlgebra)
      .map(([kind, handler]) => [kind, (node, source) => { nodes++; return handler(node, source); }]));
    const point = implementation.core.foldGraph(graph, algebra);
    prepared = {point, sourceNodes: nodes, preparedNodes: nodes, sharedNodes: 0};
  }
  const state = {base: implementation.fields.sampleDomain(contexts[0]), values: new Map()};
  prepared.point(state);
  return {sourceNodes: prepared.sourceNodes, preparedNodes: prepared.preparedNodes,
    sharedNodes: prepared.sharedNodes, firstSampleMemoEntries: state.values.size};
}

function paired(baseline, current, iterations) {
  const operations = {baseline, current}, samples = {baseline: [], current: []};
  for (const operation of Object.values(operations)) for (let i = 0; i < 100; i++) observed = operation(i);
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

const [baseline, current] = await Promise.all([load(resolve(process.argv[2])), load(root, true)]);
const cases = {};
for (const [name, fixture] of Object.entries(fixtures(current.core))) {
  const json = current.core.serializeGraph(current.core.expressionGraph(fixture.expression));
  const oldGraph = baseline.core.parseExpressionGraph(json), newGraph = current.core.parseExpressionGraph(json);
  const oldSample = baseline.core.createFieldSampler(oldGraph), newSample = current.core.createFieldSampler(newGraph);
  for (const context of contexts) assert.deepEqual(newSample(context), oldSample(context));
  cases[name] = {
    description: fixture.description, graphSHA256: createHash('sha256').update(json).digest('hex'),
    baseline: preparation(baseline, oldGraph), current: preparation(current, newGraph),
    exactSampleContexts: contexts.length,
    importAndPrepare: paired(
      () => baseline.core.createFieldSampler(baseline.core.parseExpressionGraph(json)),
      () => current.core.createFieldSampler(current.core.parseExpressionGraph(json)), preparationIterations),
    samplePrepared: paired(i => oldSample(contexts[i % contexts.length]), i => newSample(contexts[i % contexts.length]), samplingIterations),
  };
}
const result = {
  version: current.version,
  environment: {node: process.version, platform: process.platform, architecture: process.arch},
  method: {runs, preparationIterations, samplingIterations, warmupOperations: 100, order: 'Alternating baseline/current batches.', explicitGC: !!globalThis.gc},
  scope: 'CPU only. Preparation includes JSON parsing, graph ownership/validation and closure preparation. Sampling invokes an already prepared public sampler with varying contexts. Excludes GPU, browser, shader compilation and rendering.',
  baseline: {version: baseline.version, sourceSHA256: baseline.sourceSHA256},
  current: {version: current.version, sourceSHA256: current.sourceSHA256}, cases,
};
const output = resolve(root, process.argv[3] ?? evidencePath('sharing.json'));
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({output, cases: Object.fromEntries(Object.entries(cases).map(([name, item]) => [name, {
  nodes: [item.baseline.preparedNodes, item.current.preparedNodes],
  sampleMicroseconds: [item.samplePrepared.baselineMicroseconds, item.samplePrepared.currentMicroseconds],
  sampleSpeedup: item.samplePrepared.speedup,
  importAndPrepareMicroseconds: [item.importAndPrepare.baselineMicroseconds, item.importAndPrepare.currentMicroseconds],
}]))}, null, 2));
void observed;

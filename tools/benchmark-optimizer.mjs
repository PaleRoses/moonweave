/** Real egglog scaling and compiled/observational checks against an immutable checkout. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {color, materialGraph, named, scalar, serializeGraph, surface} from '../src/core.mjs';
import {createOptimizationJob, applyOptimization} from '../src/optimize.mjs';
import {compareGraphs} from './compare-graphs.mjs';
import {evidencePath} from './evidence-path.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node tools/benchmark-optimizer.mjs BASELINE_CHECKOUT [receipt.json]');
const baselineRoot = resolve(process.argv[2]);
const output = process.argv[3] ? resolve(process.argv[3]) : evidencePath('optimizer.json');
const previous = await import(pathToFileURL(resolve(baselineRoot, 'src/optimize.mjs')));
const previousCore = await import(pathToFileURL(resolve(baselineRoot, 'src/core.mjs')));
const hash = value => createHash('sha256').update(value).digest('hex');

function chain(layers) {
  const base = named('substrate', surface.material(color.srgb('#294e62')));
  const ink = named('pigment', color.srgb('#c6bba6'));
  const coverage = named('coverage', scalar.parameter(.4));
  let result = base;
  for (let index = 0; index < layers; index++) {
    result = surface.coat(surface.channels(result, {
      roughness: named(`finish${index}`, scalar.parameter(.1 + .8 * index / layers)),
    }), ink, coverage);
  }
  return materialGraph(result);
}

const cases = [4, 8, 12, 16, 24, 30].map(layers => {
  const graph = chain(layers), source = serializeGraph(graph);
  return {name: `finish-coat-${layers}`, layers, graph, source,
    baseline: previous.createOptimizationJob(previousCore.parseGraph(source)), current: createOptimizationJob(graph)};
});
const request = cases.map(({name, baseline, current}) => ({name, baseline, current}));
const native = JSON.parse(execFileSync(process.env.MOONWEAVE_EGGLOG_PYTHON || 'python3',
  [resolve(root, 'tools/egglog/benchmark.py'), baselineRoot], {
    input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000,
  }));
const results = cases.map((entry, index) => {
  const run = native[index];
  assert.equal(run.name, entry.name);
  const before = previous.applyOptimization(previousCore.parseGraph(entry.source), run.candidates.baseline);
  const after = applyOptimization(entry.graph, run.candidates.current);
  assert.equal(before.accepted, true); assert.equal(after.accepted, true);
  assert.deepEqual(after.after, before.after);
  const observations = compareGraphs(entry.graph, after.graph, {
    contexts: [{position: [0, 0, 0]}, {position: [.2, -.5, 1]}],
    patches: [{}, {finish0: {value: -.3}, [`finish${entry.layers - 1}`]: {value: .84}, coverage: {value: .73}}],
  });
  assert.equal(observations.differences, 0);
  for (const candidate of Object.values(run.candidates)) assert.equal(candidate.receipt.stopReason, 'saturated');
  return {name: entry.name, layers: entry.layers, graphNodes: entry.graph.nodes.length,
    inputTerms: entry.current.terms.length, graphSHA256: hash(entry.source),
    proof: after.proof, beforeCost: after.before, afterCost: after.after, observations,
    milliseconds: run.milliseconds,
    baseline: run.candidates.baseline.receipt, current: run.candidates.current.receipt};
});

async function provenance(directory) {
  const sources = ['src/core/effects.mts', 'src/core/optimize.mts', 'tools/optimize-graph.mjs',
    ...(await readdir(resolve(directory, 'tools/egglog'))).filter(name => name.endsWith('.py') || name === 'requirements.txt')
      .map(name => `tools/egglog/${name}`)];
  return {version: JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')).version,
    headCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: directory, encoding: 'utf8'}).trim(),
    sourceSHA256: Object.fromEntries(await Promise.all(sources.sort().map(async path =>
      [path, hash(await readFile(resolve(directory, path)))])))};
}
const receipt = {
  benchmark: 'finish-demand/1', method: 'Seven alternating paired batches of fresh native engines, including validation, parsing, projection, equality search, extraction and decoding. Python process startup and Node graph compilation are outside timing.',
  scope: 'This chain family isolates shadowed finish writes. The demand phase has at most 16 contexts per source surface; this is not a complexity bound for the following general equality search.',
  baseline: await provenance(baselineRoot), current: await provenance(root), results,
};
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({output, results: results.map(result => ({layers: result.layers,
  rows: [result.baseline.rows, result.current.rows],
  matches: [result.baseline, result.current].map(run => Object.values(run.matches).reduce((sum, n) => sum + n, 0)),
  milliseconds: [result.milliseconds.baseline.median, result.milliseconds.current.median],
  projectionContexts: result.current.projection.contexts,
}))}, null, 2));

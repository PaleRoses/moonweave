import {evidencePath} from './evidence-path.mjs';
/** Paired evidence for canonical program borrowing and inactive mark pruning. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node --expose-gc tools/benchmark-mark-cleanup.mjs <baseline-directory> [receipt.json]');
const runs = 7, warmupOperations = 4;
const hash = value => createHash('sha256').update(value).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let observed;

async function load(directory) {
  const core = await import(pathToFileURL(resolve(directory, 'src/core.mjs')).href);
  const {version} = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const sourceSHA256 = {};
  for (const path of ['src/paint/marks.mts', 'src/paint/mark-raster.mts', 'src/paint/mark-apply.mts',
    'src/core/algebra.mts', 'src/core/resources.mts', 'src/core/ownership.mts',
    'src/core/image-filter.mts', 'src/core/graph.mts', 'src/core/color.mts', 'package.json']) {
    sourceSHA256[path] = hash(await readFile(resolve(directory, path)));
  }
  return {core, version, sourceSHA256};
}

function paired(baseline, current, iterations) {
  const operations = {baseline, current}, samples = {baseline: [], current: []};
  for (const operation of Object.values(operations)) for (let i = 0; i < warmupOperations; i++) observed = operation();
  for (let run = 0; run < runs; run++) {
    for (const name of run % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      globalThis.gc?.();
      const start = performance.now(), operation = operations[name];
      for (let i = 0; i < iterations; i++) observed = operation();
      samples[name].push((performance.now() - start) * 1000 / iterations);
    }
  }
  return {iterations, unit: 'microseconds', baselineMedian: median(samples.baseline),
    currentMedian: median(samples.current), samples};
}

const [baseline, current] = await Promise.all([load(resolve(process.argv[2])), load(root)]);
const solid = {width: 1, height: 1, channels: 1, data: [1]};
const visible = {kind: 'dab', brush: 'tip', color: [.2, .4, .6], transform: [1, 0, 0, 1, 0, 0]};
const brushes = {tip: {mask: solid, filter: 'linear'}};
const large = {brushes: {tip: {mask: {width: 512, height: 512, channels: 1,
  data: Array.from({length: 512 * 512}, (_, i) => (i % 17) / 16)}}}, marks: [visible]};
const ownedBefore = baseline.core.markProgram(large), ownedAfter = current.core.markProgram(large);
assert.deepEqual(ownedAfter, ownedBefore);
assert.equal(current.core.markProgram(ownedAfter), ownedAfter);
assert.equal(current.core.compileMarkProgram(ownedAfter).program, ownedAfter);
assert.equal(current.core.serializeMarkProgram(ownedAfter), baseline.core.serializeMarkProgram(ownedBefore));
const normalization = {
  maskComponents: large.brushes.tip.mask.data.length,
  canonicalProgramSHA256: hash(current.core.serializeMarkProgram(ownedAfter)),
  raw: paired(() => baseline.core.markProgram(large), () => current.core.markProgram(large), 12),
  owned: paired(() => baseline.core.markProgram(ownedBefore), () => current.core.markProgram(ownedAfter), 100),
  compileOwned: paired(() => baseline.core.compileMarkProgram(ownedBefore), () => current.core.compileMarkProgram(ownedAfter), 40),
};

const inactive = {brushes, marks: [visible, {...visible, opacity: 0, height: .1,
  channels: {roughness: .7, metalness: .3, clearcoat: .2, opacity: .4}}]};
const shape = {width: 8, height: 8, samples: 2};
const beforeBake = baseline.core.bakeMarks(inactive, shape), afterBake = current.core.bakeMarks(inactive, shape);
const fields = bake => Object.fromEntries(['bounds', 'pigment', 'coverage', 'finishValues', 'finishCoverage', 'opacityHeight']
  .map(key => [key, bake[key]]));
assert.deepEqual(fields(afterBake), fields(beforeBake));
const graphShape = (core, bake) => {
  const graph = core.materialGraph(core.applyMarkBake(core.surface.paint('carapace'), bake));
  return {nodes: graph.nodes.length, images: graph.nodes.filter(node => node.kind === 'image').length,
    bump: graph.nodes.some(node => node.kind === 'bump'), channels: bake.channels, hasHeight: bake.hasHeight};
};
const inactiveMark = {allBakedFieldsByteIdentical: true,
  fieldsSHA256: hash(JSON.stringify(fields(afterBake))),
  baseline: graphShape(baseline.core, beforeBake), current: graphShape(current.core, afterBake)};

const zone = {mask: solid, filter: 'linear'};
const withUnused = {brushes,
  zones: Object.fromEntries(Array.from({length: 1000}, (_, i) => [`zone${i}`, zone])),
  marks: [visible, {...visible, opacity: 0, zone: 'zone999'}]};
const withoutUnused = {brushes, marks: [visible]};
const beforeZones = baseline.core.compileMarkProgram(withUnused), afterZones = current.core.compileMarkProgram(withUnused);
const beforeControl = baseline.core.compileMarkProgram(withoutUnused), afterControl = current.core.compileMarkProgram(withoutUnused);
const options = {width: 64, height: 64, samples: 2};
const zoneBake = afterZones.bake(options);
assert.deepEqual(fields(zoneBake), fields(beforeZones.bake(options)));
assert.deepEqual(fields(zoneBake), fields(afterControl.bake(options)));
const unusedZones = {declaredZones: 1000, activeZoneReferences: 0,
  allBakedFieldsByteIdentical: true, fieldsSHA256: hash(JSON.stringify(fields(zoneBake))),
  withUnused: paired(() => beforeZones.bake(options), () => afterZones.bake(options), 6),
  controlWithoutUnused: paired(() => beforeControl.bake(options), () => afterControl.bake(options), 6)};

const output = resolve(process.argv[3] ?? evidencePath('marks-cleanup.json'));
const receipt = {
  schema: 'moonweave/mark-cleanup-benchmark/1', recordedAt: new Date().toISOString(),
  environment: {node: process.version, platform: process.platform, architecture: process.arch},
  method: {runs, warmupOperations, explicitGC: !!globalThis.gc,
    order: 'Alternating baseline/current batches, with the same input and iteration counts per pair.',
    scope: 'CPU authoring only. Owned normalization proves removal of repeated validation; raw normalization still copies and validates every input sample. Zone bakes reuse compiled programs. No GPU or frame-rate claim.'},
  benchmarkSHA256: hash(await readFile(fileURLToPath(import.meta.url))),
  baseline: {version: baseline.version, sourceSHA256: baseline.sourceSHA256},
  current: {version: current.version, sourceSHA256: current.sourceSHA256},
  normalization, inactiveMark, unusedZones,
};
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({output, normalization: Object.fromEntries(['raw', 'owned', 'compileOwned']
  .map(key => [key, {before: normalization[key].baselineMedian, after: normalization[key].currentMedian}])),
  inactiveMark, unusedZones: {withUnused: [unusedZones.withUnused.baselineMedian, unusedZones.withUnused.currentMedian],
    control: [unusedZones.controlWithoutUnused.baselineMedian, unusedZones.controlWithoutUnused.currentMedian]}}, null, 2));
void observed;

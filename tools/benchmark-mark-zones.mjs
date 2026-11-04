/** Paired scaling evidence for finite-zone culling and constant-time sample reset. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {evidencePath} from './evidence-path.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node --expose-gc tools/benchmark-mark-zones.mjs <baseline-directory> [receipt.json]');
const runs = 7, warmups = 1;
const hash = value => createHash('sha256').update(value).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const fields = bake => Object.fromEntries(['pigment', 'coverage', 'finishValues', 'finishCoverage', 'opacityHeight']
  .map(key => [key, bake[key]]));
let observed;

async function load(directory) {
  const core = await import(pathToFileURL(resolve(directory, 'src/core.mjs')).href);
  const {version} = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const sourceSHA256 = {};
  for (const path of ['src/paint/marks.mts', 'src/paint/mark-raster.mts', 'src/core/resources.mts',
    'src/core/ownership.mts', 'src/core/image-filter.mts', 'src/core/algebra.mts', 'package.json']) {
    sourceSHA256[path] = hash(await readFile(resolve(directory, path)));
  }
  return {core, version, sourceSHA256};
}

function paired(before, after) {
  const operations = {baseline: before, current: after}, samples = {baseline: [], current: []};
  for (const operation of Object.values(operations)) for (let i = 0; i < warmups; i++) observed = operation();
  for (let i = 0; i < runs; i++) for (const name of i % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
    globalThis.gc?.();
    const start = performance.now();
    observed = operations[name]();
    samples[name].push(performance.now() - start);
  }
  return {unit: 'milliseconds', baselineMedian: median(samples.baseline),
    currentMedian: median(samples.current), samples};
}

const [baseline, current] = await Promise.all([load(resolve(process.argv[2])), load(root)]);
const solid = {width: 4, height: 4, channels: 1, data: Array(16).fill(1)};
const wide = [3, 0, 0, 3, -1, -1];
const brushes = {tip: {mask: solid, filter: 'linear'}};
function layout(grid, localZone) {
  const marks = [], zones = {};
  for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
    const index = y * grid + x, name = `zone${index}`;
    const local = [.5 / grid, 0, 0, .5 / grid, (x + .25) / grid, (y + .25) / grid];
    zones[name] = {mask: solid, filter: 'linear', transform: localZone ? local : wide};
    marks.push({kind: 'dab', brush: 'tip', zone: name, transform: localZone ? wide : local,
      color: [.2 + index % 3 * .2, .4, .7], opacity: .6,
      channels: {roughness: .3, metalness: .2, clearcoat: .1, opacity: .8}, height: index % 2 ? -.02 : .03});
  }
  return {brushes, zones, marks};
}

function compare(input, options) {
  const old = baseline.core.compileMarkProgram(input), next = current.core.compileMarkProgram(input);
  assert.equal(baseline.core.serializeMarkProgram(old.program), current.core.serializeMarkProgram(next.program));
  const before = old.bake(options), after = next.bake(options);
  assert.deepEqual(fields(before), fields(after));
  assert.deepEqual(before.channels, after.channels);
  assert.equal(before.hasHeight, after.hasHeight);
  return {marks: input.marks.length, activeZones: Object.keys(input.zones ?? {}).length, options,
    allImageComponentsExact: true, imagesSHA256: hash(JSON.stringify(fields(after))),
    baseline: before.stats, current: after.stats,
    timing: paired(() => old.bake(options), () => next.bake(options))};
}

const finiteZoneSupport = [];
for (const grid of [2, 4, 6, 8]) {
  const fixture = compare(layout(grid, true), {width: grid * 16, height: grid * 16, samples: 1});
  // One localized zone per tile; the baseline tests every broad brush everywhere.
  assert.equal(fixture.baseline.dabTests, fixture.marks * fixture.baseline.samples);
  assert.equal(fixture.current.dabTests, fixture.current.samples);
  assert.equal(fixture.current.tileReferences, fixture.marks);
  finiteZoneSupport.push(fixture);
}
const sparseZoneReset = [];
for (const grid of [4, 8, 16, 32]) {
  const fixture = compare(layout(grid, false), {width: 128, height: 128, samples: 1});
  assert.equal(fixture.baseline.dabTests, fixture.current.dabTests);
  assert.equal(fixture.baseline.tileReferences, fixture.current.tileReferences);
  sparseZoneReset.push(fixture);
}
const control = compare({brushes, marks: [{kind: 'dab', brush: 'tip', transform: wide,
  color: [.2, .4, .7], opacity: .6}]}, {width: 128, height: 128, samples: 1});
const output = resolve(process.argv[3] ?? evidencePath('mark-zones.json'));
const receipt = {schema: 'moonweave/mark-zones-benchmark/1', recordedAt: new Date().toISOString(),
  environment: {node: process.version, platform: process.platform, architecture: process.arch},
  method: {runs, warmups, explicitGC: !!globalThis.gc,
    order: 'Alternating baseline/current batches; each bake reuses the already-compiled program.',
    scope: 'CPU painting with identical authored programs and exact comparison of all five output resources. No GPU or universal speedup claim.',
    supportFamily: 'One finite zone per 16×16 tile. Samples = 256N; baseline candidate tests = 256N²; clipped candidate tests = 256N.',
    resetFamily: 'Broad zones and local brushes retain identical candidate sets, isolating sample-reset behavior from zone-support culling.'},
  benchmarkSHA256: hash(await readFile(fileURLToPath(import.meta.url))),
  baseline: {version: baseline.version, sourceSHA256: baseline.sourceSHA256},
  current: {version: current.version, sourceSHA256: current.sourceSHA256},
  finiteZoneSupport, sparseZoneReset, control};
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({output,
  finiteZoneSupport: finiteZoneSupport.map(x => ({marks: x.marks,
    dabTests: [x.baseline.dabTests, x.current.dabTests],
    milliseconds: [x.timing.baselineMedian, x.timing.currentMedian]})),
  sparseZoneReset: sparseZoneReset.map(x => ({zones: x.activeZones,
    milliseconds: [x.timing.baselineMedian, x.timing.currentMedian]})),
  controlMilliseconds: [control.timing.baselineMedian, control.timing.currentMedian]}, null, 2));
void observed;

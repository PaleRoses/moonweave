import {evidencePath} from './evidence-path.mjs';
/** Reproducible authoring benchmark; candidate counts are not timing speedup claims. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {carapaceMarkProgram} from '../lab/mark-examples.mts';
import {applyMarkBake, bakeMarks, color, compileMarkProgram, materialGraph, parseMarkProgram,
  serializeMarkProgram, surface} from '../src/core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(process.argv[2] ?? evidencePath('marks.json'));
const program = carapaceMarkProgram(), options = {width: 128, height: 128, bounds: [-1.3, -1.6, 1.3, 1.6], samples: 2};
const serialized = serializeMarkProgram(program);
assert.equal(serializeMarkProgram(parseMarkProgram(serialized)), serialized);
const plan = compileMarkProgram(program), first = plan.bake(options), repeated = plan.bake(options);
assert.deepEqual(repeated, first);
const graph = materialGraph(applyMarkBake(surface.material(color.linear([.1, .1, .1])), first));
const images = graph.nodes.filter(node => node.kind === 'image');
let largestAssociationError = 0;
for (let pixel = 0; pixel < first.coverage.data.length; pixel++) {
  const coverage = first.coverage.data[pixel];
  assert.ok(coverage >= 0 && coverage <= 1);
  for (let channel = 0; channel < 3; channel++) {
    const pigment = first.pigment.data[pixel * 3 + channel];
    const finish = first.finishValues.data[pixel * 3 + channel], mask = first.finishCoverage.data[pixel * 3 + channel];
    largestAssociationError = Math.max(largestAssociationError, pigment - coverage, finish - mask, -pigment, -finish);
  }
}
assert.ok(largestAssociationError <= 1e-7);
const one = {width: 1, height: 1, channels: 1, data: [1]};
const marks = [[1, 0, 0], [0, 0, 1]].map(color => ({kind: 'dab', brush: 'tip',
  transform: [1, 0, 0, 1, 0, 0], color, opacity: .5, height: .1}));
const orderProgram = {brushes: {tip: {mask: one, filter: 'linear'}}, marks};
const forward = bakeMarks(orderProgram, {width: 1, height: 1, samples: 1});
const reverse = bakeMarks({...orderProgram, marks: [...marks].reverse()}, {width: 1, height: 1, samples: 1});
assert.deepEqual(forward.pigment.data, [.25, 0, .5]);
assert.deepEqual(reverse.pigment.data, [.5, 0, .25]);
assert.deepEqual(forward.coverage.data, [.75]);

const runs = 7, warmups = 2;
const measure = operation => {
  for (let i = 0; i < warmups; i++) operation();
  const values = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now(); operation(); values.push(performance.now() - start);
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {unit: 'milliseconds', runs, warmups, samples: values,
    minimum: sorted[0], median: sorted[Math.floor(runs / 2)], maximum: sorted.at(-1)};
};
const sourceSHA256 = {};
for (const source of ['src/paint/marks.mts', 'src/paint/mark-raster.mts', 'src/paint/mark-apply.mts',
  'src/core/image-filter.mts', 'src/core/resources.mts', 'src/color/management.mts', 'src/core/color.mts',
  'src/core/algebra.mts', 'src/core/graph.mts', 'src/core/ownership.mts', 'package.json',
  'lab/mark-examples.mts', 'tools/benchmark-marks.mjs']) {
  sourceSHA256[source] = createHash('sha256').update(await readFile(resolve(root, source))).digest('hex');
}
const naiveCandidateTests = first.stats.samples * first.stats.dabs;
const receipt = {
  schema: 'moonweave/marks-benchmark/1', recordedAt: new Date().toISOString(), node: process.version,
  program: {marks: program.marks.length, brushes: Object.keys(program.brushes).length,
    zones: Object.keys(program.zones).length, expandedDabs: plan.dabCount,
    serializedBytes: Buffer.byteLength(serialized),
    sha256: createHash('sha256').update(serialized).digest('hex'), sourceSHA256},
  bake: {...options, stats: first.stats, naiveCandidateTests,
    candidateFraction: first.stats.dabTests / naiveCandidateTests,
    interpretation: 'Unindexed sample×dab count versus actual tile candidate tests; this is not a measured timing speedup.'},
  graph: {version: graph.version, nodes: graph.nodes.length, resources: images.length,
    components: images.reduce((sum, node) => sum + node.resource.data.length, 0)},
  checks: {programRoundtrip: true, repeatBakeBitExact: true, orderedPigment: true,
    coverageWithinUnitRange: true, largestAssociationError},
  timings: {compile: measure(() => compileMarkProgram(program)), bake: measure(() => plan.bake(options))},
};
await mkdir(dirname(destination), {recursive: true});
await writeFile(destination, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({file: destination, marks: receipt.program.marks, dabs: plan.dabCount,
  candidates: first.stats.dabTests, naiveCandidates: naiveCandidateTests, graph: receipt.graph,
  compileMedianMs: receipt.timings.compile.median, bakeMedianMs: receipt.timings.bake.median}));

/** Optional native integration gate: real extraction, source ownership and finite edit observations. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {compileGraph, patchGraph} from '../src/core.mjs';
import {verifyOptimization} from '../src/optimize.mjs';
import {createFinishStudy} from '../examples/optimize-effects.mjs';
import {optimizeGraph} from './optimize-graph.mjs';
import {optimizationFixtures, optimizationContexts} from './optimization-fixtures.mjs';
import {compareGraphs} from './compare-graphs.mjs';
import {evidencePath} from './evidence-path.mjs';

const contexts = optimizationContexts();
const output = process.argv[2] ? resolve(process.argv[2]) : evidencePath('optimizer-check.json');
const directory = process.argv[3] ? resolve(process.argv[3]) : undefined;
await mkdir(dirname(output), {recursive: true});
if (directory) await mkdir(directory, {recursive: true});
const mixed = retainSharedConsumer => ({
  id: retainSharedConsumer ? 'mixed-shared-consumer' : 'mixed-overwrite',
  label: retainSharedConsumer ? 'Nested mix with a live shared finish' : 'Nested mix with an overwritten finish',
  graph: createFinishStudy({retainSharedConsumer}),
  patches: [{}, {creatureFinish: {value: .91}, coverage: {value: -.3}, branchWeight: {value: 1}},
    {creatureFinish: {value: -.2}, depth: {value: -.008}, branchWeight: {value: 0},
      finishAtlas: {resource: {width: 2, height: 1, channels: 1, data: [.9, .1]}}}],
  expected: {imageRetained: retainSharedConsumer, strictImprovement: !retainSharedConsumer},
});
const fixtures = [...optimizationFixtures(), mixed(false), mixed(true)];
const results = [], cases = [];
for (const fixture of fixtures) {
  const {candidate, result} = optimizeGraph(fixture.graph);
  assert.equal(candidate.receipt.stopReason, 'saturated', fixture.id);
  assert.equal(result.proof.equivalent, true, fixture.id);
  if (fixture.expected.strictImprovement) assert.equal(result.accepted, true, fixture.id);
  const retained = new Map(result.graph.nodes.map(node => [node.id, node]));
  for (const node of fixture.graph.nodes) assert.deepEqual(retained.get(node.id), node, fixture.id);
  for (const patch of fixture.patches) {
    assert.equal(verifyOptimization(patchGraph(fixture.graph, patch), candidate).equivalent, true, fixture.id);
  }
  const plan = compileGraph(result.graph);
  assert.equal(plan.nodes.some(node => node.kind === 'image'), fixture.expected.imageRetained, fixture.id);
  const observations = compareGraphs(fixture.graph, result.graph, {
    contexts, patches: fixture.patches, paint: fixture.paint,
  });
  assert.equal(observations.differences, 0, fixture.id);
  results.push({id: fixture.id, accepted: result.accepted, reason: result.reason,
    retainedSourceNodes: fixture.graph.nodes.length, proof: result.proof,
    before: result.before, after: result.after, observations, engine: candidate.receipt});
  if (directory) {
    const entry = {id: fixture.id, label: fixture.label};
    for (const [name, value] of Object.entries({before: fixture.graph, after: result.graph, patches: fixture.patches})) {
      entry[name] = `${fixture.id}-${name}.json`;
      await writeFile(resolve(directory, entry[name]), JSON.stringify(value, null, 2) + '\n');
    }
    cases.push(entry);
  }
}
if (directory) await writeFile(resolve(directory, 'cases.json'), JSON.stringify({version: 1, cases}, null, 2) + '\n');
await writeFile(output, JSON.stringify({engine: 'egglog', version: '14.0.0', results}, null, 2) + '\n');
console.log(JSON.stringify({output, directory, results: results.map(({id, accepted, before, after, observations}) =>
  ({id, accepted, before, after, observations}))}, null, 2));

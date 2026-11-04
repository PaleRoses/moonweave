import {evidencePath} from './evidence-path.mjs';
/** Paired extraction of overlapping graph roots; import and timing stay separate. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {cpus} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
const rounds = 7, iterations = 200, warmup = 100;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = Array.from({length: 41}, (_, index) => `step${index}`);
const document = {version: 2, output: ids.at(-1), nodes: [{id: ids[0], kind: 'parameter', value: .2}]};
for (let i = 1; i < ids.length; i++) document.nodes.push(
  {id: `gain${i}`, kind: 'parameter', value: i / 100},
  {id: ids[i], kind: 'add', a: ids[i - 1], b: `gain${i}`},
);
const json = JSON.stringify(document);
let observed;

async function load(directory) {
  const core = await import(pathToFileURL(resolve(directory, 'src/core.mjs')).href);
  const version = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')).version;
  const sourceSHA256 = {};
  for (const file of ['src/core/graph.mts', 'src/core/algebra.mts', 'src/core/ownership.mts']) {
    sourceSHA256[file] = sha(await readFile(resolve(directory, file)));
  }
  return {core, version, sourceSHA256};
}

function extract(core, graph, roots) {
  for (const id of roots) observed = core.graphExpression(graph, id);
}

async function counts(directory) {
  const algebraURL = pathToFileURL(resolve(directory, 'src/core/algebra.mts')).href;
  let visits = 0;
  globalThis.__moonweaveReificationVisit = () => { visits++; };
  const hook = registerHooks({load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url === algebraURL) {
      const source = String(loaded.source), anchor = 'const source = read(key);';
      assert.equal(source.split(anchor).length, 2, 'one fold read anchor is required');
      loaded.source = source.replace(anchor, `${anchor} globalThis.__moonweaveReificationVisit();`);
    }
    return loaded;
  }});
  try {
    const {core} = await load(directory), result = {};
    for (const [name, roots] of Object.entries({overlapping41: ids, singleRoot81: [ids.at(-1)]})) {
      const graph = core.parseExpressionGraph(json);
      visits = 0;
      extract(core, graph, roots);
      result[name] = {sourceNodeVisits: visits, ownedExpressions: core.expressionGraph(core.graphExpression(graph)).nodes.length};
    }
    return result;
  } finally {
    hook.deregister();
    delete globalThis.__moonweaveReificationVisit;
  }
}

function measure(implementations, roots) {
  const samplesMicroseconds = {baseline: [], current: []};
  for (const {core} of Object.values(implementations)) {
    for (let i = 0; i < warmup; i++) extract(core, core.parseExpressionGraph(json), roots);
  }
  for (let run = 0; run < rounds; run++) {
    for (const label of run % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      const {core} = implementations[label];
      const graphs = Array.from({length: iterations}, () => core.parseExpressionGraph(json));
      globalThis.gc?.();
      const start = performance.now();
      for (const graph of graphs) extract(core, graph, roots);
      samplesMicroseconds[label].push((performance.now() - start) * 1000 / iterations);
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const baselineMicroseconds = median(samplesMicroseconds.baseline), currentMicroseconds = median(samplesMicroseconds.current);
  return {baselineMicroseconds, currentMicroseconds, speedup: baselineMicroseconds / currentMicroseconds, samplesMicroseconds};
}

async function main() {
  if (!process.argv[2]) throw new Error('Usage: node --expose-gc tools/benchmark-reification.mjs <baseline-directory> [receipt.json]');
  const directories = {baseline: resolve(process.argv[2]), current: root};
  const implementations = {};
  for (const [label, directory] of Object.entries(directories)) implementations[label] = await load(directory);
  const results = {};
  for (const [name, roots] of Object.entries({overlapping41: ids, singleRoot81: [ids.at(-1)]})) {
    const outputs = Object.values(implementations).map(({core}) => {
      const graph = core.parseExpressionGraph(json);
      extract(core, graph, roots);
      return ids.map(id => core.serializeGraph(core.graphExpression(graph, id)));
    });
    assert.deepEqual(outputs[0], outputs[1]);
    results[name] = {outputs: roots.length, exactCanonicalRoots: ids.length, ...measure(implementations, roots)};
  }
  const metadata = Object.fromEntries(Object.entries(implementations).map(([label, {core, ...identity}]) => [label, {
    ...identity,
    workCounts: JSON.parse(execFileSync(process.execPath, [script, '--counts', directories[label]], {encoding: 'utf8'})),
  }]));
  const report = {version: implementations.current.version,
    environment: {node: process.version, platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model},
    method: {rounds, iterationsPerRound: iterations, warmupPerCase: warmup, explicitGC: !!globalThis.gc,
      timing: 'Alternating baseline/current batches. Each extraction starts from an already-validated fresh graph; import, JSON parsing and explicit GC are outside timing. One-root control uses the same 81-node graph.',
      counts: 'Separate subprocesses instrument the internal fold read in memory; counts exclude imports and fixture creation. No timed implementation is instrumented.',
      scope: 'Synchronous CPU graph-to-expression extraction only; no sampling, rendering, GPU, DOM or storage timing. Fingerprints cover the three affected ownership/traversal modules.'},
    fixture: {authoredNodes: document.nodes.length, overlappingRoots: ids.length, graphSHA256: sha(json)},
    benchmarkSHA256: sha(await readFile(script)), ...metadata, results};
  const output = resolve(process.argv[3] ?? evidencePath('reification.json'));
  await mkdir(dirname(output), {recursive: true});
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({output, results, workCounts: Object.fromEntries(Object.entries(metadata).map(([label, data]) => [label, data.workCounts]))}, null, 2));
}

if (process.argv[2] === '--counts') console.log(JSON.stringify(await counts(resolve(process.argv[3]))));
else await main();
void observed;

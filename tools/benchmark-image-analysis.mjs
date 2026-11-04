/** Paired image-range analysis: reader count and image size vary independently. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {cpus} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {evidencePath} from './evidence-path.mjs';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
const rounds = 7, iterations = 8, warmup = 4;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scenarios = [32, 128, 512].flatMap(size => [1, 4, 16, 64].map(readers => ({size, readers, channels: 1})));
scenarios.push({size: 128, readers: 63, channels: 3});
const nameOf = ({size, readers, channels}) => `${size}x${size}_${readers}Readers_${channels}Channels`;
let observed;

async function load(directory) {
  const core = await import(pathToFileURL(resolve(directory, 'src/core.mjs')).href);
  const version = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')).version;
  const sourceSHA256 = {};
  for (const file of ['src/core/resources.mts', 'src/core/analyze.mts', 'src/core/compile.mts',
    'src/core/graph.mts', 'src/core/algebra.mts', 'src/core/ownership.mts', 'src/core/intern.mts']) {
    sourceSHA256[file] = sha(await readFile(resolve(directory, file)));
  }
  return {core, version, sourceSHA256};
}

function pixels({size, channels}, shift = 0) {
  return {width: size, height: size, channels,
    data: Float32Array.from({length: size * size * channels}, (_, index) => ((index * 17) % 257 - 128) / 128 + shift)};
}

function fixture(core, scenario, data = pixels(scenario)) {
  const resource = core.image.data(data).resource;
  const nodes = [{id: 'pixels', kind: 'image', resource}], leaves = [];
  for (let i = 0; i < scenario.readers; i++) {
    const frame = `frame${i}`, id = `reader${i}`;
    nodes.push({id: frame, kind: 'transform',
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i / 17, 0, 0, 1]},
    {id, kind: 'imageScalar', image: 'pixels', domain: frame,
      channel: ['r', 'g', 'b'][i % 3], address: ['clamp', 'repeat', 'zero'][i % 3],
      filter: ['linear', 'trilinear', 'anisotropic'][Math.floor(i / 3) % 3]});
    leaves.push(id);
  }
  function sum(ids) {
    if (ids.length === 1) return ids[0];
    const split = ids.length >> 1, a = sum(ids.slice(0, split)), b = sum(ids.slice(split));
    const id = `sum${nodes.length}`;
    nodes.push({id, kind: 'add', a, b});
    return id;
  }
  const roughness = sum(leaves);
  nodes.push({id: 'color', kind: 'color', value: [.2, .3, .4]},
    {id: 'material', kind: 'material', color: 'color'},
    {id: 'output', kind: 'channels', input: 'material', values: {roughness}});
  return core.materialGraph({version: 2, nodes, output: 'output'});
}

function prepare(core, scenario, mode) {
  const graph = fixture(core, scenario);
  if (mode === 'cold') return () => core.compileGraph(graph);
  core.compileGraph(graph);
  const next = mode === 'replacement'
    ? core.patchGraph(graph, {pixels: {resource: core.image.data(pixels(scenario, .25)).resource}})
    : core.materialGraph({...graph, nodes: [...graph.nodes]});
  return () => core.compileGraph(next);
}

async function counts(directory) {
  const modules = [resolve(directory, 'src/core/analyze.mts'), resolve(directory, 'src/core/resources.mts')]
    .map(path => pathToFileURL(path).href);
  const anchors = [
    'for (let i = channel; i < resource.data.length; i += resource.channels) {',
    'for (let i = index; i < image.data.length; i += image.channels) {',
  ];
  let scans = 0, texelVisits = 0, instrumented = 0;
  globalThis.__moonweaveImageRangeVisit = scan => { if (scan) scans++; else texelVisits++; };
  const hook = registerHooks({load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (modules.includes(url)) {
      let source = String(loaded.source);
      for (const anchor of anchors) if (source.includes(anchor)) {
        assert.equal(source.split(anchor).length, 2, 'One range-scan anchor is required.');
        source = source.replace(anchor, `globalThis.__moonweaveImageRangeVisit(true); ${anchor} globalThis.__moonweaveImageRangeVisit(false);`);
        instrumented++;
      }
      loaded.source = source;
    }
    return loaded;
  }});
  try {
    const {core} = await load(directory), result = {};
    assert.equal(instrumented, 1, 'Exactly one implementation must own image-range scanning.');
    for (const scenario of scenarios) {
      const item = {};
      for (const mode of ['cold', 'replacement', 'borrowedResource']) {
        const operation = prepare(core, scenario, mode);
        scans = 0; texelVisits = 0;
        observed = operation();
        item[mode] = {scans, texelVisits};
      }
      result[nameOf(scenario)] = item;
    }
    return result;
  } finally {
    hook.deregister();
    delete globalThis.__moonweaveImageRangeVisit;
  }
}

function measure(implementations, operation) {
  const samplesMicroseconds = {baseline: [], current: []};
  for (const {core} of Object.values(implementations)) {
    for (let i = 0; i < warmup; i++) observed = operation(core)();
  }
  for (let run = 0; run < rounds; run++) {
    for (const label of run % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      const work = Array.from({length: iterations}, () => operation(implementations[label].core));
      globalThis.gc?.();
      const start = performance.now();
      for (const execute of work) observed = execute();
      samplesMicroseconds[label].push((performance.now() - start) * 1000 / iterations);
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const baselineMicroseconds = median(samplesMicroseconds.baseline), currentMicroseconds = median(samplesMicroseconds.current);
  return {baselineMicroseconds, currentMicroseconds, speedup: baselineMicroseconds / currentMicroseconds, samplesMicroseconds};
}

async function main() {
  if (!process.argv[2]) throw new Error('Usage: node --expose-gc tools/benchmark-image-analysis.mjs <baseline-directory> [receipt.json]');
  const directories = {baseline: resolve(process.argv[2]), current: root}, implementations = {};
  for (const [label, directory] of Object.entries(directories)) implementations[label] = await load(directory);
  const results = {};
  for (const scenario of scenarios) {
    const plans = Object.values(implementations).map(({core}) => core.compileGraph(fixture(core, scenario)));
    for (const key of ['graph', 'nodes', 'programKey', 'ranges', 'opacityRange', 'cost', 'sourceNodes']) {
      assert.deepEqual(plans[0][key], plans[1][key], `${nameOf(scenario)} ${key}`);
    }
    const modes = {};
    for (const mode of ['cold', 'replacement', 'borrowedResource']) {
      modes[mode] = measure(implementations, core => prepare(core, scenario, mode));
    }
    results[nameOf(scenario)] = {...scenario, authoredNodes: plans[1].graph.nodes.length,
      texels: scenario.size ** 2, components: scenario.size ** 2 * scenario.channels,
      exactPlans: true, modes};
    console.log(JSON.stringify({scenario: nameOf(scenario), modes}));
  }
  const raw = pixels({size: 512, channels: 1});
  const normalization = measure(implementations, core => () => core.image.data(raw));
  const rawConstructionAndCompile = {};
  for (const readers of [1, 64]) {
    const scenario = {size: 512, readers, channels: 1};
    rawConstructionAndCompile[nameOf(scenario)] = measure(implementations,
      core => () => core.compileGraph(fixture(core, scenario, raw)));
  }
  const metadata = Object.fromEntries(Object.entries(implementations).map(([label, {core, ...identity}]) => [label, {
    ...identity, workCounts: JSON.parse(execFileSync(process.execPath, [script, '--counts', directories[label]], {encoding: 'utf8'})),
  }]));
  for (const scenario of scenarios) {
    const before = metadata.baseline.workCounts[nameOf(scenario)];
    const after = metadata.current.workCounts[nameOf(scenario)];
    for (const mode of ['cold', 'replacement', 'borrowedResource']) {
      assert.deepEqual(before[mode], {scans: scenario.readers, texelVisits: scenario.size ** 2 * scenario.readers});
      const scans = mode === 'borrowedResource' ? 0 : Math.min(scenario.channels, scenario.readers);
      assert.deepEqual(after[mode], {scans, texelVisits: scenario.size ** 2 * scans});
    }
  }
  const report = {version: implementations.current.version,
    environment: {node: process.version, platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model},
    method: {rounds, iterationsPerRound: iterations, warmupPerCase: warmup, explicitGC: !!globalThis.gc,
      timing: 'Alternating paired batches. Validated graphs, raw image copying, patches and warm prerequisites are prepared outside compile timing. Each timed graph is compiled once. Raw-normalization controls include image copying/validation. Raw-construction controls include image copying, graph construction/validation and compilation, with only raw pixel generation outside timing.',
      modes: {cold: 'Fresh topology and fresh immutable image.',
        replacement: 'Previously compiled topology with one newly normalized image replacement.',
        borrowedResource: 'Fresh topology borrowing an immutable image already analyzed by another graph.'},
      counts: 'Separate subprocesses instrument the range-scan loop in memory. One texel visit reads one requested component; counts exclude normalization, graph preparation and warm prerequisites. Timed implementations are not instrumented.',
      scope: 'CPU graph compilation and image-range analysis only; no rendering or GPU timing.'},
    complexity: {baseline: 'O(R × P) range visits for R image readers and P texels.',
      current: 'O(C × P + R) for C distinct requested stored channels (C ≤ 3), independent of mappings and filters. Reusing an analyzed immutable resource needs no further pixel scan.'},
    benchmarkSHA256: sha(await readFile(script)), ...metadata, results, normalization, rawConstructionAndCompile};
  const output = resolve(process.argv[3] ?? evidencePath('image-analysis.json'));
  await mkdir(dirname(output), {recursive: true});
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({output, normalization, rawConstructionAndCompile}));
}

if (process.argv[2] === '--counts') console.log(JSON.stringify(await counts(resolve(process.argv[3]))));
else await main();
void observed;

import {evidencePath} from './evidence-path.mjs';
/** Focused, paired CPU edit benchmark; no renderer, GPU upload or frame timing. */
import * as THREE from 'three';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2]) throw new Error('Pass a baseline source directory, then an optional report path.');
const baselineDirectory = resolve(process.argv[2]);
const reportPath = resolve(process.argv[3] ?? evidencePath('analysis.json'));
const iterations = 700, rounds = 7;
const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .01, .02, 0, 1];
const amount = index => ((index % 97) + 1) / 100;
let observed;

async function load(directory) {
  const module = path => import(pathToFileURL(resolve(directory, path)).href);
  const [core, adapter, pkg] = await Promise.all([
    module('src/core.mjs'), module('src/three.mjs'),
    readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const sourceSHA256 = {};
  const files = [['src/core/compile.mts', 'src/core/compile.mjs', 'src/surface-graph-plan.mjs'],
    ['src/three/uniforms.mts', 'src/three/uniforms.mts', 'src/graph-uniforms.mjs'], ['src/three/adapter.mts', 'src/three/adapter.mjs', 'src/texturing-adapter.mjs']];
  for (const candidates of files) {
    const file = candidates.find(path=>existsSync(resolve(directory,path)));
    assert(file, `Missing measured source: ${candidates.join(', ')}`);
    sourceSHA256[file] = createHash('sha256').update(await readFile(resolve(directory, file))).digest('hex');
  }
  const fields = adapter.createPaintTextures(THREE, {
    topData: new Uint8Array(512 * 512 * 4), wallData: new Uint8Array(512 * 512 * 4),
  });
  const system = adapter.createTexturingSystem(THREE, {fields});
  return {core, system, fields, version: pkg.version, sourceSHA256};
}

function scenario(api, domains) {
  const {domain, facets, surface, scalar, materialGraph} = api.core;
  let frame;
  for (let index = 0; index < domains; index++) frame = domain.transform(matrix, frame);
  const field = facets({domain: frame});
  const graph = materialGraph(surface.mix(surface.paint(field, 'carapace'), surface.paint(field, 'horn'),
    scalar.ramp(scalar.parameter(.5), 0, 1)));
  const paint = graph.nodes.find(node => node.kind === 'paint').id;
  const parameter = graph.nodes.find(node => node.kind === 'parameter').id;
  const handle = api.system.createMaterial(graph);
  const shader = {vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}};
  handle.material.onBeforeCompile(shader);
  return {
    handle, shader, graphNodes: graph.nodes.length,
    key: handle.material.customProgramCacheKey(), version: handle.material.version,
    roughness: index => handle.patch({[paint]: {style: {roughness: amount(index)}}}),
    parameter: index => handle.patch({[parameter]: {value: amount(index)}}),
  };
}

function timed(operation) {
  globalThis.gc?.();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) observed = operation(index);
  return (performance.now() - start) * 1000 / iterations;
}

function work(operation) {
  const fround = Math.fround, parse = Number.parseInt;
  let roundedComponents = 0, colorDecodes = 0;
  Math.fround = value => {roundedComponents++; return fround(value);};
  Number.parseInt = (...args) => {colorDecodes++; return parse(...args);};
  try {operation(55);} finally {Math.fround = fround; Number.parseInt = parse;}
  return {roundedComponents, colorDecodes};
}

const baseline = await load(baselineDirectory), current = await load(root);
const report = {
  environment: {node: process.version, platform: process.platform, architecture: process.arch},
  metric: 'CPU material value edits in microseconds; includes validation, plan binding/analysis and uniform object writes; excludes rendering/GPU upload.',
  iterations, rounds, order: 'Alternating baseline/current order each round after 150 warm-up edits.',
  baseline: {version: baseline.version, sourceSHA256: baseline.sourceSHA256},
  current: {version: current.version, sourceSHA256: current.sourceSHA256},
  scenarios: {},
};
try {
  for (const domains of [0, 8, 24]) {
    const before = scenario(baseline, domains), after = scenario(current, domains);
    const metrics = {};
    for (const edit of ['roughness', 'parameter']) {
      for (let index = 0; index < 150; index++) {before[edit](index); after[edit](index);}
      const samples = {baseline: [], current: []};
      for (let round = 0; round < rounds; round++) {
        for (const [label, value] of round % 2 ? [['current', after], ['baseline', before]] : [['baseline', before], ['current', after]]) {
          samples[label].push(timed(value[edit]));
        }
      }
      const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      const baselineMicroseconds = median(samples.baseline), currentMicroseconds = median(samples.current);
      metrics[edit] = {baselineMicroseconds, currentMicroseconds, speedup: baselineMicroseconds / currentMicroseconds,
        samplesMicroseconds: samples, work: {baseline: work(before[edit]), current: work(after[edit])}};
      for (const value of [before, after]) {
        assert.equal(value.handle.material.customProgramCacheKey(), value.key);
        assert.equal(value.handle.material.version, value.version);
      }
      console.log(JSON.stringify({domains, edit, baselineMicroseconds, currentMicroseconds,
        speedup: metrics[edit].speedup, work: metrics[edit].work}));
    }
    report.scenarios[`${domains}Domains`] = {graphNodes: after.graphNodes, metrics};
    before.handle.dispose(); after.handle.dispose();
  }
} finally {
  baseline.system.dispose(); current.system.dispose();
  baseline.fields.dispose(); current.fields.dispose();
}
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
assert(observed);

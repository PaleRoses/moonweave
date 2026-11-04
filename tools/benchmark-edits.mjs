import {evidencePath} from './evidence-path.mjs';
/** Paired CPU edit measurements; an optional source directory supplies the baseline. */
import * as THREE from 'three';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runs = 7;
const iterations = 500;
let observed;

function measure(operation) {
  for (let i = 0; i < 100; i++) observed = operation(i);
  const samples = [];
  for (let run = 0; run < runs; run++) {
    globalThis.gc?.();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) observed = operation(i);
    samples.push((performance.now() - start) * 1000 / iterations);
  }
  const ordered = [...samples].sort((a, b) => a - b);
  return {medianMicroseconds: ordered[Math.floor(runs / 2)], samplesMicroseconds: samples};
}

function rawPatch(graph, changes) {
  return {...graph, nodes: graph.nodes.map(node => {
    const patch = changes[node.id];
    if (!patch) return node;
    if (!patch.style) return {...node, ...patch};
    return {...node, ...patch, style: {...node.style, ...patch.style}};
  })};
}

async function exercise(directory) {
  const module = relative => import(pathToFileURL(resolve(directory, relative)).href);
  const [core, adapter, pkg] = await Promise.all([
    module('src/core.mjs'), module('src/three.mjs'),
    readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const {facets, surface, scalar, materialGraph, compileGraph, parseGraph, serializeGraph, evaluateScalar} = core;
  const patchGraph = core.patchGraph ?? ((graph, changes) => materialGraph(rawPatch(graph, changes)));
  const scenarios = {};
  const system = adapter.createTexturingSystem(THREE);
  for (const paintCount of [2, 16]) {
    const field = facets();
    let expression = surface.paint(field, 'carapace');
    for (let i = 1; i < paintCount; i++) {
      expression = surface.mix(expression, surface.paint(field, i % 2 ? 'horn' : 'membrane'), scalar.parameter(.5));
    }
    const graph = materialGraph(expression);
    const source = serializeGraph(graph);
    const parameterId = graph.nodes.find(node => node.kind === 'parameter').id;
    const paintId = graph.nodes.find(node => node.kind === 'paint').id;
    const context = {position: [.2, -.3, .1], normal: [0, 1, 0]};
    const handle = system.createMaterial(graph);
    const shader = {vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}};
    handle.material.onBeforeCompile(shader);
    const uniformObjects = Object.entries(shader.uniforms);
    const materialVersion = handle.material.version;
    const programKey = handle.material.customProgramCacheKey();
    const topology = handle.plan.structure;
    const amount = i => (i % 101) / 100;
    const edit = changes => handle.patch
      ? handle.patch(changes)
      : handle.setGraph(patchGraph(handle.graph, changes));
    const metrics = {
      importJSON: measure(() => parseGraph(source)),
      reuseValidatedGraph: measure(() => materialGraph(graph)),
      reuseConstructedExpression: measure(() => materialGraph(expression)),
      compileFreshDocument: measure(() => compileGraph(JSON.parse(source))),
      reuseCompiledGraph: measure(() => compileGraph(graph)),
      evaluateScalar: measure(() => evaluateScalar(graph, parameterId, context)),
      setIdenticalGraph: measure(() => handle.setGraph(handle.graph)),
      editParameter: measure(i => edit({[parameterId]: {value: amount(i)}})),
      editPaint: measure(i => edit({[paintId]: {style: {contrast: amount(i)}}})),
    };
    assert.equal(handle.material.version, materialVersion);
    assert.equal(handle.material.customProgramCacheKey(), programKey);
    for (const [name, uniform] of uniformObjects) assert.equal(shader.uniforms[name], uniform);
    if (topology) assert.equal(handle.plan.structure, topology);
    assert.equal(handle.graph.nodes.find(node => node.id === parameterId).value, amount(iterations - 1));
    assert.equal(handle.graph.nodes.find(node => node.id === paintId).style.contrast, amount(iterations - 1));
    scenarios[`${paintCount}Paints`] = {nodeCount: graph.nodes.length, metrics,
      stableMaterialProgramAndUniformObjects: true, sharedCompiledStructure: !!topology};
    handle.dispose();
  }
  system.dispose();
  const sampling = {};
  // Leave room for the canonical material's three color nodes within 256 nodes.
  for (const parameterCount of [3, 125]) {
    let layer = Array.from({length: parameterCount}, (_, i) => scalar.parameter((i + 1) / (parameterCount * parameterCount)));
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) next.push(layer[i + 1] ? scalar.add(layer[i], layer[i + 1]) : layer[i]);
      layer = next;
    }
    const graph = materialGraph(surface.channels(surface.paint(), {roughness: layer[0]}));
    const rootId = graph.nodes.find(node => node.id === graph.output).values.roughness;
    const context = {position: [.2, -.3, .1], normal: [0, 1, 0]};
    const expected = (parameterCount + 1) / (2 * parameterCount);
    assert.ok(Math.abs(evaluateScalar(graph, rootId, context).value - expected) < 1e-12);
    const source = serializeGraph(graph);
    sampling[`${parameterCount}Parameters`] = {
      graphNodes: graph.nodes.length,
      description: 'Evaluate a complete balanced sum of independent parameters, not an individual leaf.',
      ...measure(() => evaluateScalar(graph, rootId, context)),
      importAndFirstSample: measure(() => evaluateScalar(parseGraph(source), rootId, context)),
    };
  }
  const sourceSHA256 = {};
  const fingerprint = (await readdir(resolve(directory, 'src'), {recursive: true})).filter(name => /\.(?:mjs|mts)$/.test(name) && !name.endsWith('.d.mts')).sort();
  for (const name of fingerprint) {
    sourceSHA256[`src/${name}`] = createHash('sha256').update(await readFile(resolve(directory, 'src', name))).digest('hex');
  }
  return {version: pkg.version, sourceSHA256, scenarios, sampling};
}

const baseline = process.argv[2] ? await exercise(resolve(process.argv[2])) : null;
const current = await exercise(root);
const comparison = {};
if (baseline) for (const [name, scenario] of Object.entries(current.scenarios)) {
  comparison[name] = Object.fromEntries(Object.entries(scenario.metrics).map(([metric, value]) => [metric, {
    baselineMicroseconds: baseline.scenarios[name].metrics[metric].medianMicroseconds,
    currentMicroseconds: value.medianMicroseconds,
    speedup: baseline.scenarios[name].metrics[metric].medianMicroseconds / value.medianMicroseconds,
  }]));
}
const samplingComparison = baseline ? Object.fromEntries(Object.entries(current.sampling).map(([name, value]) => [name, {
  baselineMicroseconds: baseline.sampling[name].medianMicroseconds,
  currentMicroseconds: value.medianMicroseconds,
  speedup: baseline.sampling[name].medianMicroseconds / value.medianMicroseconds,
  importAndFirstSample: {
    baselineMicroseconds: baseline.sampling[name].importAndFirstSample.medianMicroseconds,
    currentMicroseconds: value.importAndFirstSample.medianMicroseconds,
    speedup: baseline.sampling[name].importAndFirstSample.medianMicroseconds / value.importAndFirstSample.medianMicroseconds,
  },
}])) : null;
const result = {
  environment: {node: process.version, three: THREE.REVISION, platform: process.platform, architecture: process.arch},
  method: `${runs} runs of ${iterations} operations after 100 warm-up operations per metric; medians in microseconds per operation. ${globalThis.gc ? 'Explicit GC before each batch.' : 'No explicit GC.'}`,
  scope: 'CPU operations only. Excludes DOM, texture generation/upload, driver compilation and rendering. Separate baseline/current implementations run in the same process with the same inputs and Three revision.',
  baseline, current, comparison, samplingComparison,
};
await writeFile(resolve(root, process.argv[3] ?? evidencePath('edits.json')), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({environment: result.environment, comparison: baseline ? comparison : current.scenarios, samplingComparison}, null, 2));
void observed;

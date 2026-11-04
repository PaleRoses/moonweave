import {evidencePath} from './evidence-path.mjs';
/** Compare real compiled representations; these counts are not frame timings. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as core from '../src/core.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';

const [baselinePath, reportPath = evidencePath('pigments.json')] = process.argv.slice(2);
if (!baselinePath) throw new Error('Usage: node tools/measure-pigments.mjs <baseline> [report.json]');
const baselineRoot = resolve(baselinePath);
const old = await import(pathToFileURL(resolve(baselineRoot, 'src/core.mjs')));
const oldShader = (await import(pathToFileURL(resolve(baselineRoot, 'src/three/shader.mjs')))).generateSurfaceShader;
const oldExamples = (await import(pathToFileURL(resolve(baselineRoot, 'lab/composition.mts')))).COMPOSITION_EXAMPLES;
const shaderText = (graph, api, generate) => {
  const shader = generate(api.compileGraph(graph));
  return shader.declarations + shader.evaluate;
};
const sourceHashes = directory => {
  const files = readdirSync(resolve(directory, 'src'), {recursive: true})
    .filter(path => /\.(?:mjs|mts)$/.test(path) && !path.endsWith('.d.mts')).map(path => `src/${path}`);
  files.push('lab/composition.mts', 'lab/surface-examples.mts');
  if (directory === process.cwd()) files.push('lab/painterly-examples.mts', 'tools/measure-pigments.mjs');
  return Object.fromEntries(files.sort().map(path => [path,
    createHash('sha256').update(readFileSync(resolve(directory, path))).digest('hex')]));
};
const legacy = {};
for (const [name, example] of Object.entries(oldExamples)) {
  const before = example.create(), after = COMPOSITION_EXAMPLES[name].create();
  assert.equal(core.serializeGraph(after), old.serializeGraph(before));
  assert.deepEqual(core.compileGraph(after).nodes, old.compileGraph(before).nodes);
  assert.equal(core.compileGraph(after).programKey, old.compileGraph(before).programKey);
  assert.equal(shaderText(after, core, generateSurfaceShader), shaderText(before, old, oldShader));
  legacy[name] = {sameGraph: true, sameCompiledNodes: true, sameProgramKey: true, sameShader: true};
}
const {color, scalar, mask, named, materialGraph, compileGraph, patchGraph, surface} = core;
const input = named('pigment', color.oklch([.62, .08, 220]));
const bare = materialGraph(surface.material(input));
const identity = materialGraph(surface.material(color.adjust(input, {hue: 720})));
assert.equal(compileGraph(identity).programKey, compileGraph(bare).programKey);
assert.equal(shaderText(identity, core, generateSurfaceShader), shaderText(bare, core, generateSurfaceShader));
const live = materialGraph(surface.material(color.adjust(input, {
  lightness: named('lightness', scalar.parameter(0)),
  chroma: named('chroma', scalar.parameter(1)), hue: named('hue', scalar.parameter(0)),
})));
const plan = compileGraph(live), edited = compileGraph(patchGraph(live, {
  lightness: {value: -.12}, chroma: {value: .8}, hue: {value: 155},
}));
assert.equal(edited.programKey, plan.programKey);
assert.equal(edited.structure, plan.structure);
const measure = graph => {
  const plan = compileGraph(graph);
  return {authoredNodes: graph.nodes.length, liveNodes: plan.nodes.length,
    graphJSONBytes: Buffer.byteLength(core.serializeGraph(graph)),
    generatedGLSLBytes: Buffer.byteLength(shaderText(graph, core, generateSurfaceShader)), ...plan.cost};
};
const coverage = mask.chisel();
const maskGraph = materialGraph(surface.material(color.mix(color.linear([0, 0, 0]), color.linear([1, 1, 1]), coverage)));
const studies = Object.fromEntries(['ivory', 'brass'].map(name => {
  const graph = COMPOSITION_EXAMPLES[name].create(), cost = measure(graph);
  assert.equal(cost.textureReads, 4);
  assert.equal(cost.proceduralSamples, 0);
  assert.equal(graph.nodes.filter(node => node.kind === 'bump').length, 0);
  return [name, cost];
}));
const report = {
  version: JSON.parse(readFileSync('package.json')).version,
  baselineVersion: JSON.parse(readFileSync(resolve(baselineRoot, 'package.json'))).version,
  method: 'Independent baseline/current core and shader imports; exact prior graph/program/GLSL comparisons. Static representation and emitted-work counts, with no CPU/GPU speed claim.',
  legacy, literalIdentity: {sameProgram: true, sameShader: true, ...measure(identity)},
  liveAdjustment: {sameProgramAcrossEdit: true, sameStructureAcrossEdit: true, ...measure(live)},
  chisel: {scalarNodes: core.expressionGraph(coverage).nodes.length, withColorMaterial: measure(maskGraph)},
  studies, sourceSHA256: {baseline: sourceHashes(baselineRoot), current: sourceHashes(process.cwd())},
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({legacyExamples: Object.keys(legacy).length, literalIdentity: report.literalIdentity,
  liveAdjustment: report.liveAdjustment, chisel: report.chisel, studies, report: reportPath}, null, 2));

import {evidencePath} from './evidence-path.mjs';
/** Reproducible representation and emitted-work measurements, without timing claims. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as current from '../src/core.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [baselineArgument, reportArgument = evidencePath('fields.json')] = process.argv.slice(2);
if (!baselineArgument) throw new Error('Usage: node tools/measure-fields.mjs <baseline-directory> [output-report.json]');
const baselineRoot = resolve(baselineArgument);
const baseline = await import(pathToFileURL(resolve(baselineRoot, 'src/core.mjs')));
const baselineShader = await import(pathToFileURL(resolve(baselineRoot, 'src/three/shader.mjs')));
const baselineExamples = (await import(pathToFileURL(resolve(baselineRoot, 'lab/composition.mts')))).COMPOSITION_EXAMPLES;
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value);
const nonblankLines = source => source.split('\n').filter(line => line.trim()).join('\n');

function makeHeight(core, amplitude = .035) {
  const {domain, named, scalar} = core;
  const frame = named('space', domain.transform([2.8, 0, 0, 0, 0, 1.3, 0, 0, 0, 0, 3.1, 0, 0, 0, 0, 1]));
  const grain = named('grain', scalar.noise({seed: 37, domain: frame}));
  const shape = named('shape', scalar.ramp(grain, .2, .8));
  return named('height', scalar.multiply(named('amplitude', scalar.parameter(amplitude)), shape));
}

const height = makeHeight(current), field = current.expressionGraph(height);
const wrapped = baseline.materialGraph(baseline.surface.channels(
  baseline.surface.material(baseline.color.srgb('#e3dcc0')), {roughness: makeHeight(baseline)},
));
const sampler = current.createFieldSampler(field);
assert.equal(current.createFieldSampler(field), sampler);
assert.equal(current.createFieldSampler(height), sampler);
const contexts = [-.81, -.27, .14, .53].flatMap(x => [-.4, .19, .72].flatMap(y => [-.6, .33].map(z => ({
  position: [x, y, z], dx: [.011, .003, -.002], dy: [-.004, .009, .006],
}))));
let maxValueError = 0, maxDifferentialError = 0;
const before = contexts.map(context => {
  const actual = sampler(context), expected = baseline.evaluateScalar(wrapped, 'height', context);
  maxValueError = Math.max(maxValueError, Math.abs(actual.value - expected.value));
  maxDifferentialError = Math.max(maxDifferentialError, Math.abs(actual.dx - expected.dx), Math.abs(actual.dy - expected.dy));
  assert.deepEqual(actual, expected);
  return actual;
});
const editedField = current.patchGraph(field, {amplitude: {value: -.027}});
const editedSampler = current.createFieldSampler(editedField);
assert.notEqual(editedSampler, sampler);
assert.equal(current.createFieldSampler(editedField), editedSampler);
const changed = contexts.map(context => editedSampler(context));
const after = contexts.map(context => sampler(context));
assert.deepEqual(after, before);
assert.ok(changed.some((sample, index) => sample.value !== before[index].value));

function measure(graph, core, generate) {
  const plan = core.compileGraph(graph), shader = generate(plan), graphJSON = core.serializeGraph(graph);
  const planJSON = JSON.stringify({nodes: plan.nodes, output: plan.output, bindings: plan.bindings,
    cost: plan.cost, ranges: plan.ranges, opacityRange: plan.opacityRange});
  const source = shader.declarations + shader.evaluate;
  return {plan, shader, graphJSON, planJSON, source, metrics: {
    authoredNodes: graph.nodes.length, liveNodes: plan.nodes.length, uniformScalars: plan.cost.uniformScalars,
    compiledPlanJSONBytes: bytes(planJSON), programKeyBytes: bytes(plan.programKey),
    generatedGLSLBytes: bytes(source), generatedGLSLSHA256: sha(source),
  }};
}

function comparison(previous, next) {
  return {baseline: previous.metrics, current: next.metrics, equality: {
    authoredGraph: previous.graphJSON === next.graphJSON,
    compiledPlan: previous.planJSON === next.planJSON,
    programKey: previous.plan.programKey === next.plan.programKey,
    shaderDeclarations: previous.shader.declarations === next.shader.declarations,
    shaderEvaluation: previous.shader.evaluate === next.shader.evaluate,
    completeShader: previous.source === next.source,
    completeShaderNonblankLines: nonblankLines(previous.source) === nonblankLines(next.source),
  }, generatedGLSLByteChange: bytes(next.source) - bytes(previous.source)};
}

function valuePatch(graph) {
  const parameter = graph.nodes.find(node => node.kind === 'parameter');
  if (parameter) return {[parameter.id]: {value: parameter.value * .7 + .03}};
  const noise = graph.nodes.find(node => node.kind === 'noise');
  if (noise) return {[noise.id]: {seed: (noise.seed + 1) >>> 0}};
  const color = graph.nodes.find(node => node.kind === 'color');
  if (color) return {[color.id]: {value: [.23, .35, .41]}};
  const paint = graph.nodes.find(node => node.kind === 'paint');
  assert.ok(paint, 'A legacy example needs an editable input for the comparison.');
  return {[paint.id]: {style: {roughness: .67}}};
}

const legacyExamples = Object.fromEntries(Object.entries(baselineExamples).map(([name, example]) => {
  const previousGraph = example.create(), currentGraph = COMPOSITION_EXAMPLES[name].create();
  // Package self references must resolve independently in each checkout.
  assert.equal(baseline.materialGraph(previousGraph), previousGraph);
  assert.equal(current.materialGraph(currentGraph), currentGraph);
  const previous = measure(previousGraph, baseline, baselineShader.generateSurfaceShader);
  const next = measure(currentGraph, current, generateSurfaceShader), edits = valuePatch(previousGraph);
  const previousEdited = measure(baseline.patchGraph(previousGraph, edits), baseline, baselineShader.generateSurfaceShader);
  const currentEdited = measure(current.patchGraph(currentGraph, edits), current, generateSurfaceShader);
  assert.equal(previousEdited.plan.programKey, previous.plan.programKey);
  assert.equal(currentEdited.plan.programKey, next.plan.programKey);
  return [name, {initial: comparison(previous, next), valueEdit: {
    patch: edits, preservesProgramInBothVersions: true, comparison: comparison(previousEdited, currentEdited),
  }}];
}));

const {color, scalar, surface, named, materialGraph, compileGraph, patchGraph} = current;
const body = named('body', surface.material(named('pigment', color.srgb('#c9d5c8'))));
const bare = measure(materialGraph(body), current, generateSurfaceShader);
const uniformHeights = {
  literal: 4,
  parameter: named('offset', scalar.parameter(-.6)),
  composition: scalar.ramp(scalar.add(named('level', scalar.parameter(.3)), scalar.multiply(.4, scalar.parameter(.7))), -.4, .8),
};
const uniformBumps = Object.fromEntries(Object.entries(uniformHeights).map(([name, value]) => {
  const graph = materialGraph(surface.bump(body, value)), measured = measure(graph, current, generateSurfaceShader);
  assert.equal(measured.plan.programKey, bare.plan.programKey);
  assert.equal(measured.source, bare.source);
  assert.deepEqual(measured.plan.bindings, bare.plan.bindings);
  return [name, {authoredNodes: graph.nodes.length, liveNodes: measured.plan.nodes.length,
    sameInputProgram: true, sameInputShader: true, sameInputBindings: true}];
}));

const sharedNoise = named('sharedNoise', scalar.noise({seed: 41}));
const valueOnly = materialGraph(surface.channels(body, {roughness: sharedNoise}));
const heightGraph = materialGraph(surface.bump(surface.channels(body, {roughness: sharedNoise}),
  scalar.multiply(named('depth', scalar.parameter(0)), sharedNoise)));
const valueSource = generateSurfaceShader(compileGraph(valueOnly));
const detailPlan = compileGraph(heightGraph), detailSource = generateSurfaceShader(detailPlan);
const detailGLSL = detailSource.declarations + detailSource.evaluate;
const differentialCalls = (detailSource.evaluate.match(/= mwNoiseSample\(/g) ?? []).length;
const valueCalls = (detailSource.evaluate.match(/= mwNoise\(/g) ?? []).length;
const samplerDeclarations = (detailGLSL.match(/\bsampler2D\b/g) ?? []).length;
const textureCalls = (detailGLSL.match(/\btexture(?:2D|Lod|Grad)?\s*\(/g) ?? []).length;
assert.equal(detailPlan.cost.proceduralSamples, 1);
assert.equal(detailPlan.cost.paintSamples, 0);
assert.equal(detailPlan.cost.textureReads, 0);
assert.equal(differentialCalls, 1);
assert.equal(valueCalls, 0);
assert.equal(samplerDeclarations, 0);
assert.equal(textureCalls, 0);
assert.equal(valueSource.declarations.includes('mwNoiseSample('), false);
assert.equal(detailPlan.nodes.filter(node => node.kind === 'bump').length, 1);
const signedEdits = [-.04, 0, .05].map(value => {
  const plan = compileGraph(patchGraph(heightGraph, {depth: {value}}));
  const shader = generateSurfaceShader(plan);
  assert.equal(plan.structure, detailPlan.structure);
  assert.equal(plan.programKey, detailPlan.programKey);
  assert.equal(shader.declarations + shader.evaluate, detailGLSL);
  return {value, sameProgram: true, sameStructure: true, sameShader: true};
});

function sourceHashes(directory, extra = []) {
  const walk = path => readdirSync(resolve(directory, path), {withFileTypes: true}).flatMap(entry =>
    entry.isDirectory() ? walk(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
  const files = ['src/core.mjs', ...walk('src/core'), ...walk('src/three'), 'lab/composition.mts', ...extra];
  return Object.fromEntries(files.sort().map(path => [path, sha(readFileSync(resolve(directory, path)))]));
}

const report = {
  version: JSON.parse(readFileSync(resolve(root, 'package.json'))).version,
  baselineVersion: JSON.parse(readFileSync(resolve(baselineRoot, 'package.json'))).version,
  environment: {node: process.version, platform: process.platform, architecture: process.arch},
  method: 'Load baseline and current public cores, example constructors and shader generators independently. Compare identical standalone scalar fields with the baseline material/channels wrapper, then all baseline examples before and after a value edit. Compiled-plan JSON counts nodes, output, bindings, cost, ranges and opacityRange; program keys are counted separately. Generated GLSL includes declarations and evaluation. Noise counts are emitted call sites in evaluation code, not a GPU timing result. No CPU or GPU speed claim.',
  standaloneField: {
    baselineWrapper: {nodes: wrapped.nodes.length, serializedJSONBytes: bytes(baseline.serializeGraph(wrapped))},
    currentField: {nodes: field.nodes.length, serializedJSONBytes: bytes(current.serializeGraph(field))},
    contexts: contexts.length, comparedComponents: contexts.length * 3, maxValueError, maxDifferentialError,
    preparedSamplerReused: true, expressionAndGraphShareSampler: true,
    editedGraphHasIndependentSampler: true, previousSamplerUnaffected: true,
  },
  legacyExamples,
  uniformHeightElimination: {inputLiveNodes: bare.plan.nodes.length, cases: uniformBumps},
  sharedHeightAndRoughness: {
    liveNoiseNodes: detailPlan.cost.proceduralSamples, generatedDifferentialNoiseCalls: differentialCalls,
    generatedValueOnlyNoiseCalls: valueCalls, paintSamples: detailPlan.cost.paintSamples, textureReads: detailPlan.cost.textureReads,
    generatedSamplerDeclarations: samplerDeclarations, generatedTextureCalls: textureCalls,
    valueOnlyShaderOmitsNoiseDifferentialHelper: true,
    valueOnlyGLSLBytes: bytes(valueSource.declarations + valueSource.evaluate),
    heightGLSLBytes: bytes(detailSource.declarations + detailSource.evaluate),
    zeroParameterRetainsVaryingHeight: true, signedEdits,
  },
  sourceSHA256: {
    baseline: sourceHashes(baselineRoot),
    current: sourceHashes(root, ['lab/surface-examples.mts', 'tools/measure-fields.mjs']),
  },
};
writeFileSync(resolve(reportArgument), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({report: relative(root, resolve(reportArgument)), standaloneField: report.standaloneField,
  legacyExamples: Object.fromEntries(Object.entries(legacyExamples).map(([name, value]) => [name,
    {equality: value.initial.equality, generatedGLSLByteChange: value.initial.generatedGLSLByteChange,
      editedPlanEqual: value.valueEdit.comparison.equality.compiledPlan}])),
  uniformHeightElimination: report.uniformHeightElimination, sharedHeightAndRoughness: report.sharedHeightAndRoughness,
}, null, 2));

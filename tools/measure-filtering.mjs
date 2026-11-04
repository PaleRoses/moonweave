import {evidencePath} from './evidence-path.mjs';
/** Independent analytic area reference, representation cost and v55 compatibility. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as core from '../src/core.mjs';
import {generateImage} from '../src/core/resources.mts';
import {imagePyramid, imageFilterPlan, sampleFilteredImage} from '../src/core/image-filter.mts';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';

const [baselinePath, reportPath = evidencePath('filtering.json'), gridPath = 'validation/filtering-grid.json'] = process.argv.slice(2);
if (!baselinePath) throw new Error('Usage: node tools/measure-filtering.mjs <baseline> [report.json] [grid.json]');
const baselineRoot = resolve(baselinePath);
const old = await import(pathToFileURL(resolve(baselineRoot, 'src/core.mjs')));
const oldShader = (await import(pathToFileURL(resolve(baselineRoot, 'src/three/shader.mjs')))).generateSurfaceShader;
const oldExamples = (await import(pathToFileURL(resolve(baselineRoot, 'lab/composition.mts')))).COMPOSITION_EXAMPLES;
const bytes = value => Buffer.byteLength(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const shaderText = (graph, api = core, generate = generateSurfaceShader) => {
  const shader = generate(api.compileGraph(graph));
  return shader.declarations + shader.evaluate;
};

const legacy = {};
for (const [name, example] of Object.entries(oldExamples)) {
  assert(COMPOSITION_EXAMPLES[name], `Missing legacy example ${name}`);
  const before = example.create(), after = COMPOSITION_EXAMPLES[name].create();
  const oldPlan = old.compileGraph(before), plan = core.compileGraph(after);
  assert.equal(core.serializeGraph(after), old.serializeGraph(before), `${name} graph changed`);
  assert.deepEqual(plan.nodes, oldPlan.nodes, `${name} compiled nodes changed`);
  assert.equal(plan.programKey, oldPlan.programKey, `${name} program key changed`);
  assert.equal(shaderText(after), shaderText(before, old, oldShader), `${name} generated shader changed`);
  legacy[name] = {sameGraph: true, sameCompiledNodes: true, sameProgramKey: true, sameShader: true};
}

function measure(graph) {
  const plan = core.compileGraph(graph), images = plan.nodes.filter(node => node.kind === 'image');
  const resources = [...new Set(images.map(node => node.resource))];
  const details = resources.map(resource => {
    const levels = imagePyramid(resource);
    return {
      width: resource.width, height: resource.height, channels: resource.channels,
      authoredComponents: resource.data.length, authoredFloat32PayloadBytes: resource.data.length * 4,
      mipDimensions: levels.map(level => [level.width, level.height]),
      mipFloat32PayloadBytes: levels.reduce((sum, level) => sum + level.data.length * 4, 0),
      rgba32fBaseLevelBytes: resource.width * resource.height * 16,
      rgba32fPyramidBytes: levels.reduce((sum, level) => sum + level.width * level.height * 16, 0),
    };
  });
  const json = core.serializeGraph(graph), glsl = shaderText(graph);
  return {
    authoredNodes: graph.nodes.length, liveNodes: plan.nodes.length,
    graphJSONBytes: bytes(json), generatedGLSLBytes: bytes(glsl), programKeyBytes: bytes(plan.programKey),
    uniqueResourceObjects: resources.length, imageSamplerBindings: images.length,
    scalarReaders: plan.nodes.filter(node => node.kind === 'imageScalar').length,
    colorReaders: plan.nodes.filter(node => node.kind === 'imageColor').length,
    authoredFloat32PayloadBytes: details.reduce((sum, resource) => sum + resource.authoredFloat32PayloadBytes, 0),
    rgba32fPyramidBytes: details.reduce((sum, resource) => sum + resource.rgba32fPyramidBytes, 0),
    resources: details, cost: plan.cost,
    graphSHA256: sha256(json), generatedGLSLSHA256: sha256(glsl),
  };
}

const studies = Object.fromEntries(['zones', 'pigments', 'inscription'].map(name => [name, measure(COMPOSITION_EXAMPLES[name].create())]));
assert.equal(studies.inscription.uniqueResourceObjects, 1);
assert.equal(studies.inscription.scalarReaders, 6);
assert.equal(studies.inscription.cost.textureReads, 132); // Two shared 64-read ceilings + the original four-read field.

// The reference is the exact box average of a continuous generating function,
// not another implementation of mip or tap sampling. Image tabulation and
// bilinear reconstruction approximation are therefore included in the error.
const size = 128, gridSize = 64, origin = [.0073, .0137];
const source = generateImage({width: size, height: size, channels: 1}, (u, v) =>
  .5 + .25 * Math.sin(2 * Math.PI * 32 * u) + .2 * Math.sin(2 * Math.PI * 8 * v));
const sinc = x => Math.abs(x) < 1e-14 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
const average = (uv, footprint) => .5
  + .25 * Math.sin(2 * Math.PI * 32 * uv[0]) * sinc(32 * footprint.dx[0]) * sinc(32 * footprint.dy[0])
  + .2 * Math.sin(2 * Math.PI * 8 * uv[1]) * sinc(8 * footprint.dx[1]) * sinc(8 * footprint.dy[1]);
const cases = {
  isotropic: {label: '4 × 4 texel footprint', footprint: {dx: [4 / size, 0], dy: [0, 4 / size]}},
  oblique: {label: 'Oblique 16 × 0.5 texel footprint', footprint: {dx: [16 / size, .002], dy: [.001, .5 / size]}},
};
const comparisons = {}, grids = {};
for (const [name, {label, footprint}] of Object.entries(cases)) {
  const values = {reference: [], linear: [], trilinear: [], anisotropic: []};
  const totals = Object.fromEntries(['linear', 'trilinear', 'anisotropic'].map(filter => [filter, {squares: 0, max: 0}]));
  for (let y = 0; y < gridSize; y++) for (let x = 0; x < gridSize; x++) {
    const uv = origin.map((value, i) => value + x * footprint.dx[i] + y * footprint.dy[i]);
    const reference = average(uv, footprint);
    values.reference.push(reference);
    for (const filter of Object.keys(totals)) {
      const actual = sampleFilteredImage(source, uv, 'repeat', filter, footprint).value[0];
      assert(Number.isFinite(actual));
      values[filter].push(actual);
      const error = Math.abs(actual - reference);
      totals[filter].squares += error * error;
      totals[filter].max = Math.max(totals[filter].max, error);
    }
  }
  const metrics = Object.fromEntries(Object.entries(totals).map(([filter, total]) => [filter, {
    rmsError: Math.sqrt(total.squares / (gridSize * gridSize)), maxAbsoluteError: total.max,
    plan: imageFilterPlan(source, footprint, filter, 'repeat'),
  }]));
  assert(metrics.trilinear.rmsError < metrics.linear.rmsError, `${name}: mip filtering should improve this reference case`);
  assert(metrics.anisotropic.rmsError < metrics.linear.rmsError, `${name}: anisotropic filtering should improve this reference case`);
  if (name === 'oblique') assert(metrics.anisotropic.rmsError < metrics.trilinear.rmsError,
    'Oblique: anisotropic filtering should retain the low-frequency minor-axis signal');
  comparisons[name] = {label, footprint, samples: gridSize * gridSize, metrics};
  grids[name] = {label, width: gridSize, height: gridSize, values};
}

const hashFiles = readdirSync('src', {recursive: true})
  .filter(file => /\.(?:mjs|mts)$/.test(file)).map(file => `src/${file}`)
  .concat(['package.json', 'package-lock.json', 'lab/application-examples.mts', 'lab/composition.mts',
    'tests/filter-grammar.test.mjs', 'tests/image-filter.test.mjs', 'tests/image-filter-gpu.test.mjs',
    'tests/filter-applications.test.mjs', 'tools/measure-filtering.mjs']).sort();
const report = {
  version: JSON.parse(readFileSync('package.json', 'utf8')).version,
  baselineVersion: JSON.parse(readFileSync(resolve(baselineRoot, 'package.json'), 'utf8')).version,
  legacyExamples: Object.keys(legacy).length, legacy, studies,
  accounting: 'Static work ceilings and float32 payload/upload counts, not render timings, driver allocation or JavaScript heap size. All images upload a shared pyramid. Graph JSON contains only authored level zero.',
  reference: {
    function: 'f(u,v)=0.5+0.25*sin(2π*32*u)+0.2*sin(2π*8*v)',
    image: {width: size, height: size, channels: 1}, gridSize, origin,
    formula: 'A sinusoid in coordinate i is attenuated by sinc(frequency*dx[i])*sinc(frequency*dy[i]) over a centered screen-pixel parallelogram; sinc(x)=sin(πx)/(πx).',
    method: 'Exact continuous generating-function box average, compared with the actual float32 image sampler at 4096 positions per footprint. Error includes tabulation, reconstruction and filter approximations. These cases are not a universal quality bound or a native GPU performance measurement.',
  },
  comparisons,
  sourceSHA256: Object.fromEntries(hashFiles.map(file => [file, sha256(readFileSync(file))])),
};
for (const path of [reportPath, gridPath]) mkdirSync(dirname(resolve(path)), {recursive: true});
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(gridPath, JSON.stringify({range: [0, 1], grids}));
console.log(JSON.stringify({legacyExamples: report.legacyExamples, inscription: studies.inscription,
  comparisons, reportPath, gridPath}, null, 2));

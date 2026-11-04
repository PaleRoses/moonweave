import {evidencePath} from './evidence-path.mjs';
/** Source equivalence, resource representation and sampled spectral-table error. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as core from '../src/core.mjs';
import {linearToOklab} from '../src/core/color.mts';
import {sampleImage} from '../src/core/resources.mts';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';

const [baselinePath, reportPath = evidencePath('applications.json')] = process.argv.slice(2);
if (!baselinePath) throw new Error('Usage: node tools/measure-applications.mjs <baseline> [report.json]');
const baselineRoot = resolve(baselinePath), currentRoot = process.cwd();
const old = await import(pathToFileURL(resolve(baselineRoot, 'src/core.mjs')));
const oldShader = (await import(pathToFileURL(resolve(baselineRoot, 'src/three/shader.mjs')))).generateSurfaceShader;
const oldExamples = (await import(pathToFileURL(resolve(baselineRoot, 'lab/composition.mts')))).COMPOSITION_EXAMPLES;
const bytes = value => Buffer.byteLength(value);
const shaderText = (graph, api = core, generate = generateSurfaceShader) => {
  const shader = generate(api.compileGraph(graph));
  return shader.declarations + shader.evaluate;
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

function sourceHashes(directory) {
  const files = readdirSync(resolve(directory, 'src'), {recursive: true})
    .filter(path => /\.(?:mjs|mts)$/.test(path) && !path.endsWith('.d.mts')).map(path => `src/${path}`);
  for (const file of ['package.json', 'package-lock.json', 'lab/composition.mts', 'lab/surface-examples.mts',
    'lab/painterly-examples.mts', 'lab/application-examples.mts', 'src/color/SPECTRAL-LICENSE.txt',
    'tests/fixtures/spectral-3.json', 'tests/pigment.test.mjs', 'tests/resources.test.mjs',
    'tests/image-graph.test.mjs', 'tests/zones.test.mjs', 'tools/measure-applications.mjs']) {
    if (existsSync(resolve(directory, file))) files.push(file);
  }
  return Object.fromEntries(files.sort().map(file => [file, sha256(readFileSync(resolve(directory, file)))]));
}

const legacy = {};
for (const [name, example] of Object.entries(oldExamples)) {
  assert(COMPOSITION_EXAMPLES[name], `Missing legacy example ${name}`);
  const before = example.create(), after = COMPOSITION_EXAMPLES[name].create();
  const oldPlan = old.compileGraph(before), plan = core.compileGraph(after);
  assert.equal(core.serializeGraph(after), old.serializeGraph(before), `${name} graph changed`);
  assert.deepEqual(plan.nodes, oldPlan.nodes, `${name} compiled nodes changed`);
  assert.equal(plan.programKey, oldPlan.programKey, `${name} program key changed`);
  assert.equal(shaderText(after), shaderText(before, old, oldShader), `${name} generated shader changed`);
  legacy[name] = {sameGraph: true, sameCompiledNodes: true, sameProgramKey: true, sameShader: true,
    authoredNodes: after.nodes.length, liveNodes: plan.nodes.length,
    graphJSONBytes: bytes(core.serializeGraph(after)), generatedGLSLBytes: bytes(shaderText(after))};
}

function measure(graph) {
  const plan = core.compileGraph(graph);
  const images = plan.nodes.filter(node => node.kind === 'image');
  const resources = [...new Set(images.map(node => node.resource))];
  const resourceDetails = resources.map(resource => ({
    sourceIds: graph.nodes.filter(node => node.kind === 'image' && node.resource === resource).map(node => node.id),
    width: resource.width, height: resource.height, channels: resource.channels,
    components: resource.data.length, float32PayloadBytes: resource.data.length * 4,
    rgba32fBaseLevelBytes: resource.width * resource.height * 16,
  }));
  const json = core.serializeGraph(graph), glsl = shaderText(graph);
  return {
    authoredNodes: graph.nodes.length, liveNodes: plan.nodes.length,
    graphJSONBytes: bytes(json), generatedGLSLBytes: bytes(glsl), programKeyBytes: bytes(plan.programKey),
    authoredImageNodes: graph.nodes.filter(node => node.kind === 'image').length,
    liveImageNodes: images.length, uniqueResourceObjects: resources.length,
    scalarImageSamples: plan.nodes.filter(node => node.kind === 'imageScalar').length,
    colorImageSamples: plan.nodes.filter(node => node.kind === 'imageColor').length,
    imageSamplerBindings: images.length,
    imageFloat32PayloadBytes: resourceDetails.reduce((sum, resource) => sum + resource.float32PayloadBytes, 0),
    imageRgba32fBaseLevelBytes: resourceDetails.reduce((sum, resource) => sum + resource.rgba32fBaseLevelBytes, 0),
    graphSHA256: sha256(json), generatedGLSLSHA256: sha256(glsl),
    resources: resourceDetails, ...plan.cost,
  };
}

const studyGraphs = Object.fromEntries(['zones', 'pigments'].map(name => [name, COMPOSITION_EXAMPLES[name].create()]));
const studies = Object.fromEntries(Object.entries(studyGraphs).map(([name, graph]) => [name, measure(graph)]));
for (const study of Object.values(studies)) {
  assert.equal(study.paintSamples, 1, 'The original painted surface is sampled once');
  assert.equal(study.proceduralSamples, 0, 'These resource studies have no procedural noise opcode');
}

// Check the actual example's table, including its float32 ownership boundary.
// The texel centers store t=i/(N-1); a desired mixture t therefore samples
// at u=((N-1)*t+0.5)/N, not u=t. v is arbitrary for this one-row resource.
const table = studyGraphs.pigments.nodes.find(node => node.id === 'patinaPigmentTable')?.resource;
assert(table && table.width === 64 && table.height === 1 && table.channels === 3);
const endpointSwatches = {yellow: '#dcc878', blue: '#315e79'};
const yellow = core.pigment.srgb(endpointSwatches.yellow), blue = core.pigment.srgb(endpointSwatches.blue);
const direct = t => core.pigment.toLinear(core.pigment.mix(yellow, blue, t));
let maxTexelQuantizationError = 0;
for (let i = 0; i < table.width; i++) {
  const expected = direct(i / (table.width - 1)), stored = table.data.slice(i * 3, i * 3 + 3);
  assert.deepEqual(stored, expected.map(Math.fround), 'The example palette changed; update its documented reference swatches');
  expected.forEach((value, channel) => { maxTexelQuantizationError = Math.max(maxTexelQuantizationError, Math.abs(value - stored[channel])); });
}
const positions = 1025;
let maxLinearRgbComponentError = 0, maxOklabDistance = 0, sumSquares = 0, worstRgb, worstOklab;
const maxErrorByChannel = [0, 0, 0];
for (let index = 0; index < positions; index++) {
  const t = index / (positions - 1), u = ((table.width - 1) * t + .5) / table.width;
  const actual = sampleImage(table, [u, .5], 'clamp').value, expected = direct(t);
  const error = actual.map((component, channel) => Math.abs(component - expected[channel]));
  error.forEach((value, channel) => {
    assert(Number.isFinite(value));
    sumSquares += value * value;
    maxErrorByChannel[channel] = Math.max(maxErrorByChannel[channel], value);
    if (value > maxLinearRgbComponentError) {
      maxLinearRgbComponentError = value;
      worstRgb = {t, u, channel: ['r', 'g', 'b'][channel], expected, actual};
    }
  });
  const labActual = linearToOklab(actual), labExpected = linearToOklab(expected);
  const distance = Math.hypot(...labActual.map((component, channel) => component - labExpected[channel]));
  assert(Number.isFinite(distance));
  if (distance > maxOklabDistance) { maxOklabDistance = distance; worstOklab = {t, u, expected: labExpected, actual: labActual}; }
}

// These fixtures were produced by executing the inspected upstream script,
// not by recording Moonweave's output. Stable inversion changes dark rounding.
const fixture = JSON.parse(readFileSync(resolve(currentRoot, 'tests/fixtures/spectral-3.json'), 'utf8'));
let maxUpstreamComponentError = 0;
for (const entry of fixture.cases) {
  const a = core.pigment.srgb(entry.a, {tintingStrength: entry.strengthA});
  const b = core.pigment.srgb(entry.b, {tintingStrength: entry.strengthB});
  const actual = core.pigment.toLinear(core.pigment.mix(a, b, entry.t));
  for (let channel = 0; channel < 3; channel++) {
    maxUpstreamComponentError = Math.max(maxUpstreamComponentError, Math.abs(actual[channel] - entry.linear[channel]));
  }
}
assert(maxUpstreamComponentError < 1e-12);

const report = {
  version: JSON.parse(readFileSync('package.json', 'utf8')).version,
  baselineVersion: JSON.parse(readFileSync(resolve(baselineRoot, 'package.json'), 'utf8')).version,
  method: 'Independent baseline/current graph, compiler and shader imports; exact legacy comparisons. Static emitted-work and numeric payload counts, not render timings or JavaScript heap measurements.',
  resourceAccounting: 'Float32 payload counts the authored channels. RGBA32F base-level bytes count the adapter upload expansion and exclude driver overhead. Shared existing paint atlases are not included in these image payload totals. Four texture reads are emitted per image point reconstruction; no mipmapping or anisotropic filtering.',
  legacyExamples: Object.keys(legacy).length, legacy, studies,
  spectralPalette: {
    width: table.width, endpointSwatches, endpointMixturePositions: [0, 1], sampledPositions: positions,
    correspondence: 'texel i stores t=i/63; mixture t uses u=(63*t+0.5)/64, v=0.5. An arbitrary image coordinate u corresponds to direct t=clamp((64*u-0.5)/63,0,1).',
    method: 'CPU bilinear sampling of the actual float32 resource versus direct 38-band pigment evaluation; Oklab uses the existing shared conversion. Results are observed errors on an inclusive uniform grid, not a global bound or native GPU parity measurement.',
    maxTexelQuantizationError, maxLinearRgbComponentError, maxErrorByChannel,
    rmsLinearRgbComponentError: Math.sqrt(sumSquares / (positions * 3)),
    maxOklabDistance, oklabDistanceScale: 'Euclidean Oklab distance with lightness in [0,1], not a percentage',
    worstRgb, worstOklab,
  },
  upstreamPigment: {cases: fixture.cases.length, components: fixture.cases.length * 3,
    maxLinearRgbComponentError: maxUpstreamComponentError, provenance: fixture.provenance},
  sourceSHA256: {baseline: sourceHashes(baselineRoot), current: sourceHashes(currentRoot)},
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({legacyExamples: report.legacyExamples, studies,
  spectralPalette: report.spectralPalette, upstreamPigment: report.upstreamPigment, report: reportPath}, null, 2));

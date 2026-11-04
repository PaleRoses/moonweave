import {evidencePath} from './evidence-path.mjs';
/**
 * Compare a baseline checkout with current source without rendering.
 * Run from any directory:
 *   node tools/check-gallery.mjs <baseline-directory> [receipt.json]
 *
 * This captures each real Three WebGLProgram assembler's source. The GL object
 * records strings only; it does not compile, link, upload, or render a program.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as THREE from 'three';
import * as Legacy from 'three-legacy';
import {WebGLProgram} from 'three/src/renderers/webgl/WebGLProgram.js';
import {WebGLProgram as LegacyWebGLProgram} from 'three-legacy/src/renderers/webgl/WebGLProgram.js';

const [baselinePath, receiptPath] = process.argv.slice(2);
if (!baselinePath) throw new Error('Usage: node tools/check-gallery.mjs <baseline-directory> [receipt.json]');
const currentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineRoot = resolve(baselinePath);
const destination = resolve(receiptPath ?? evidencePath('gallery.json'));
const load = (root, path) => import(pathToFileURL(resolve(root, path)));
const registry = root => existsSync(resolve(root, 'lab/examples.mts'))
  ? 'lab/examples.mts' : 'lab/composition.mts';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, (_key, item) => {
  if (typeof item !== 'number') return item;
  if (!Number.isFinite(item)) return {$number: String(item)};
  return Object.is(item, -0) ? {$number: '-0'} : item;
});

function fingerprints(root) {
  const paths = [];
  function visit(path) {
    for (const entry of readdirSync(resolve(root, path), {withFileTypes: true})) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (/\.(?:mjs|mts|ts|tsx)$/.test(child) && !/\.d\.(?:mts|ts)$/.test(child)) paths.push(child);
    }
  }
  visit('src');
  visit('lab');
  return Object.fromEntries(paths.sort().map(path => [path, sha256(readFileSync(resolve(root, path)))]));
}

const sources = {baseline: fingerprints(baselineRoot), current: fingerprints(currentRoot)};
const before = {
  core: await load(baselineRoot, 'src/core.mjs'),
  three: await load(baselineRoot, 'src/three.mjs'),
  shader: await load(baselineRoot, 'src/three/shader.mjs'),
  examples: (await load(baselineRoot, registry(baselineRoot))).COMPOSITION_EXAMPLES,
};
const after = {
  core: await load(currentRoot, 'src/core.mjs'),
  three: await load(currentRoot, 'src/three.mjs'),
  shader: await load(currentRoot, 'src/three/shader.mjs'),
  examples: (await load(currentRoot, registry(currentRoot))).COMPOSITION_EXAMPLES,
};

function identical(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  assert.equal(encode(actual), encode(expected), `${label}: serialized representation`);
  return sha256(encode(actual));
}

function expand(source, chunks) {
  return source.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_match, name) => {
    assert(Object.hasOwn(chunks, name), `Missing Three shader chunk: ${name}`);
    return expand(chunks[name], chunks);
  });
}

function assemble(engine, handle) {
  const shader = {
    vertexShader: engine.ShaderLib.physical.vertexShader,
    fragmentShader: engine.ShaderLib.physical.fragmentShader,
    uniforms: {},
  };
  handle.material.onBeforeCompile(shader);
  const captured = {};
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    createProgram: () => ({}), createShader: type => ({type}),
    shaderSource(stage, source) { captured[stage.type === 0x8b31 ? 'vertex' : 'fragment'] = source; },
    compileShader() {}, attachShader() {}, linkProgram() {}, bindAttribLocation() {}, deleteShader() {},
  };
  const parameters = {
    defines: handle.material.defines, shaderType: 'MeshPhysicalMaterial', shaderName: 'MoonweaveCompatibility',
    vertexShader: expand(shader.vertexShader, engine.ShaderChunk),
    fragmentShader: expand(shader.fragmentShader, engine.ShaderChunk),
    precision: 'highp', vertexNormals: true, clearcoat: true, doubleSided: true,
    hasPositionAttribute: true, opaque: true, envMap: false,
    toneMapping: THREE.ACESFilmicToneMapping, outputColorSpace: THREE.SRGBColorSpace,
    numSunLights: 0, numDirLights: 1, numSpotLights: 0, numSpotLightMaps: 0,
    numRectAreaLights: 0, numPointLights: 0, numHemiLights: 0, numLightProbeGrids: 0,
    numSunLightShadows: 0, numDirLightShadows: 0, numSpotLightShadows: 0,
    numSpotLightShadowsWithMaps: 0, numPointLightShadows: 0,
    numClippingPlanes: 0, numClipIntersection: 0, rendererExtensionParallelShaderCompile: false,
    isWebGL2: true, shaderID: 'physical', outputEncoding: Legacy.sRGBEncoding,
  };
  const Assembler = engine === Legacy ? LegacyWebGLProgram : WebGLProgram;
  new Assembler({getContext: () => gl, debug: {checkShaderErrors: false}}, 'compatibility', parameters, {});
  assert.equal(typeof captured.vertex, 'string');
  assert.equal(typeof captured.fragment, 'string');
  return {
    vertex: captured.vertex, fragment: captured.fragment,
    programKey: handle.material.customProgramCacheKey(),
    uniforms: Object.fromEntries(Object.entries(shader.uniforms).map(([name, uniform]) => [name, uniformValue(uniform.value)])),
  };
}

function image(value) {
  if (!value) return null;
  const {width, height, data} = value;
  assert(ArrayBuffer.isView(data), 'Expected a numeric DataTexture image');
  return {width, height, components: data.length, type: data.constructor.name,
    dataSHA256: sha256(Buffer.from(data.buffer, data.byteOffset, data.byteLength))};
}

function uniformValue(value) {
  if (value?.isTexture) {
    const keys = ['type', 'format', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy',
      'generateMipmaps', 'flipY', 'unpackAlignment', 'colorSpace', 'encoding'];
    return {texture: Object.fromEntries(keys.map(key => [key, value[key]])),
      image: image(value.image), mipmaps: value.mipmaps.map(image)};
  }
  if (typeof value?.toArray === 'function') return value.toArray();
  return value;
}

const fields = ['output', 'nodes', 'ranges', 'opacityRange', 'bindings', 'cost', 'diagnostics', 'sourceNodes', 'programKey', 'structure'];
const gallery = {};
assert.deepEqual(Object.keys(after.examples), Object.keys(before.examples), 'Gallery membership/order');
assert(Object.keys(before.examples).length > 0, 'Expected a nonempty baseline gallery');

for (const [name, previousExample] of Object.entries(before.examples)) {
  const currentExample = after.examples[name];
  assert.equal(currentExample.label, previousExample.label, `${name}: label`);
  const previousGraph = previousExample.create(), currentGraph = currentExample.create();
  const previousPlan = before.core.compileGraph(previousGraph), currentPlan = after.core.compileGraph(currentGraph);
  const graphText = after.core.serializeGraph(currentGraph);
  assert.equal(graphText, before.core.serializeGraph(previousGraph), `${name}: graph serialization`);
  const hashes = Object.fromEntries(fields.map(field => [field,
    identical(currentPlan[field], previousPlan[field], `${name}: ${field}`),
  ]));
  const previousShader = before.shader.generateSurfaceShader(previousPlan);
  const currentShader = after.shader.generateSurfaceShader(currentPlan);
  for (const field of ['declarations', 'evaluate']) {
    hashes[`generated-${field}`] = identical(currentShader[field], previousShader[field], `${name}: generated ${field}`);
  }
  gallery[name] = {label: currentExample.label, authoredNodes: currentGraph.nodes.length,
    liveNodes: currentPlan.nodes.length, graphSHA256: sha256(graphText), equal: true, hashes, programs: []};
}

for (const engine of [Legacy, THREE]) {
  const previousSystem = before.three.createTexturingSystem(engine);
  const currentSystem = after.three.createTexturingSystem(engine);
  try {
    for (const coordinates of ['local', 'attribute']) {
      for (const [name, previousExample] of Object.entries(before.examples)) {
        const previous = previousSystem.createMaterial(previousExample.create(), {coordinates});
        const current = currentSystem.createMaterial(after.examples[name].create(), {coordinates});
        try {
          const previousProgram = assemble(engine, previous), currentProgram = assemble(engine, current);
          const hashes = Object.fromEntries(['vertex', 'fragment', 'programKey', 'uniforms'].map(field => [field,
            identical(currentProgram[field], previousProgram[field], `${name}/${engine.REVISION}/${coordinates}: ${field}`),
          ]));
          gallery[name].programs.push({engine: engine.REVISION, coordinates, equal: true,
            vertexBytes: Buffer.byteLength(currentProgram.vertex), fragmentBytes: Buffer.byteLength(currentProgram.fragment),
            uniforms: Object.keys(currentProgram.uniforms).length, hashes});
        } finally {
          current.dispose();
          previous.dispose();
        }
      }
    }
  } finally {
    currentSystem.dispose();
    previousSystem.dispose();
  }
}

assert.deepEqual(fingerprints(currentRoot), sources.current, 'Current source changed during verification; run again');
assert.deepEqual(fingerprints(baselineRoot), sources.baseline, 'Baseline source changed during verification');
const programPairs = Object.values(gallery).reduce((sum, example) => sum + example.programs.length, 0);
const report = {
  version: JSON.parse(readFileSync(resolve(currentRoot, 'package.json'), 'utf8')).version,
  baselineVersion: JSON.parse(readFileSync(resolve(baselineRoot, 'package.json'), 'utf8')).version,
  scope: 'Exact graph and compiler representation comparisons plus actual installed legacy/current Three adapter bindings and assembled shader strings in local/attribute coordinates. GL calls only capture source; this is not shader compilation, GPU rendering, a pixel comparison, or a performance measurement.',
  comparisons: {galleryExamples: Object.keys(gallery).length, compiledFields: fields,
    generatedFields: ['declarations', 'evaluate'], engines: [Legacy.REVISION, THREE.REVISION],
    coordinates: ['local', 'attribute'], assembledProgramPairs: programPairs, assembledPrograms: programPairs * 2,
    adapterUniformPairs: programPairs, allEqual: true},
  sourceFingerprintSHA256: {baseline: sha256(encode(sources.baseline)), current: sha256(encode(sources.current))},
  sources, gallery,
};
mkdirSync(dirname(destination), {recursive: true});
writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({receipt: relative(currentRoot, destination), ...report.comparisons}, null, 2));

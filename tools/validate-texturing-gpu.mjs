/** Actual generated Three physical shaders and data for native EGL validation. */
import * as THREE from 'three';
import * as Legacy from 'three-legacy';
import {WebGLProgram} from 'three/src/renderers/webgl/WebGLProgram.js';
import {WebGLProgram as LegacyWebGLProgram} from 'three-legacy/src/renderers/webgl/WebGLProgram.js';
import {getDFGLUT} from 'three/src/renderers/shaders/DFGLUTData.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createTexturingSystem, bindSurfaceCoordinates} from '../src/three.mjs';
import {surface, scalar, color, domain, facets, named, inDomain, patchGraph, parseGraph, splitRecipe, compileGraph} from '../src/core.mjs';
import {createSpecimen} from '../lab/specimens.mjs';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';
import {inscribedGlaze} from '../lab/application-examples.mts';
import {proceduralProbes, colorProbes} from './procedural-probes.mjs';
import {differentialProbes} from './differential-probes.mjs';
import {resourceProbes, encodeImageLevels} from './resource-probes.mjs';

const frame = domain.transform([1, 0, 0, 0, .25, .8, 0, 0, 0, 0, 1.3, 0, .3, -.1, .2, 1]);
const boundary = scalar.ramp(scalar.axis('y', frame), -.6, .65);
const sharedGraph = COMPOSITION_EXAMPLES.belly.create();
const basePalette = sharedGraph.nodes.find(node => node.id === 'basePaint').palette;
const liveEdits = {amount: {value: .38}, basePaint: {style: {contrast: .31}},
  [basePalette.base]: {value: color.srgb('#805c83').value}};
function framedComposition(frame) {
  const field = facets({...splitRecipe('carapace').mapping, domain: frame});
  const mask = scalar.multiply(scalar.ramp(scalar.facing([0, -1, 0], frame), -.3, .7), scalar.parameter(.72));
  return surface.mix(surface.paint(field, 'carapace'), surface.paint(field, 'horn'), mask);
}
const overridePaint = surface.paint('carapace', {domain: frame});
const shadowedFinish = named('shadowed-channel-ramp', scalar.ramp(scalar.axis('z'), -.55, .7));
const varyingRoughness = scalar.add(.16, scalar.multiply(.7, boundary));
const varyingMetalness = scalar.add(.04, scalar.multiply(.24,
  scalar.ramp(scalar.facing([0, -1, 0], frame), -.4, .65)));
const nestedOverrides = surface.channels(surface.channels(surface.channels(overridePaint, {
  roughness: shadowedFinish, metalness: varyingMetalness,
}), {roughness: varyingRoughness}), {clearcoat: .32});
const flatOverrides = surface.channels(overridePaint, {
  roughness: varyingRoughness, metalness: varyingMetalness, clearcoat: .32,
});
const nestedPlan = compileGraph(nestedOverrides), flatPlan = compileGraph(flatOverrides);
const shadowedSpatialFieldEliminated = !nestedPlan.bindings.some(binding => binding.sourceId === 'shadowed-channel-ramp')
  && !nestedPlan.nodes.some(node => node.kind === 'axis' && node.axis === 'z');
assert(nestedPlan.graph.nodes.some(node => node.id === 'shadowed-channel-ramp'));
assert(shadowedSpatialFieldEliminated, 'The overridden spatial field must leave the execution plan.');
assert.equal(nestedPlan.programKey, flatPlan.programKey);
assert.deepEqual(nestedPlan.nodes, flatPlan.nodes);
assert.equal(nestedPlan.nodes.filter(node => node.kind === 'channels').length, 1);
const channelOverrideComposition = {
  sourceNodes: nestedPlan.graph.nodes.length, liveNodes: nestedPlan.nodes.length,
  sourceChannelNodes: nestedPlan.graph.nodes.filter(node => node.kind === 'channels').length,
  liveChannelNodes: nestedPlan.nodes.filter(node => node.kind === 'channels').length,
  shadowedSpatialFieldEliminated, nestedEqualsFlat: true,
};
const graphs = {
  moonstone: surface.paint('moonstone'),
  carapace: surface.paint('carapace'),
  membrane: surface.paint('membrane'),
  shared: sharedGraph,
  independent: COMPOSITION_EXAMPLES.tips.create(),
  finish: COMPOSITION_EXAMPLES.finish.create(),
  channels: surface.channels(surface.relief(surface.paint('carapace', {domain: frame}),
    scalar.add(.2, scalar.multiply(.7, scalar.complement(boundary)))), {
    roughness: scalar.add(.16, scalar.multiply(.7, boundary)),
    metalness: scalar.constant(.04), clearcoat: scalar.parameter(.24), opacity: scalar.constant(1),
  }),
  patched: sharedGraph,
  reference: patchGraph(sharedGraph, liveEdits),
  framed: inDomain(framedComposition(), frame),
  'frame-reference': framedComposition(frame),
  'channel-nested': nestedOverrides,
  'channel-flat': flatOverrides,
  stone: COMPOSITION_EXAMPLES.stone.create(),
  lichen: COMPOSITION_EXAMPLES.lichen.create(),
  spectrum: COMPOSITION_EXAMPLES.spectrum.create(),
  prismatic: COMPOSITION_EXAMPLES.prismatic.create(),
  porcelain: COMPOSITION_EXAMPLES.porcelain.create(),
  weathered: COMPOSITION_EXAMPLES.weathered.create(),
  ivory: COMPOSITION_EXAMPLES.ivory.create(),
  brass: COMPOSITION_EXAMPLES.brass.create(),
  zones: COMPOSITION_EXAMPLES.zones.create(),
  pigments: COMPOSITION_EXAMPLES.pigments.create(),
  inscription: COMPOSITION_EXAMPLES.inscription.create(),
  marks: COMPOSITION_EXAMPLES.marks.create(),
  'deposit-pigment': surface.deposit(surface.channels(surface.material(color.linear([.12, .23, .34])), {roughness: .6}),
    color.linear([.2, .1, .04]), .5, {roughness: {value: .1, coverage: .25}, clearcoat: {value: .15, coverage: .5}}),
  'deposit-reference': surface.channels(surface.coat(surface.material(color.linear([.12, .23, .34])),
    color.linear([.4, .2, .08]), .5), {roughness: .1 + .75 * .6, clearcoat: .15}),
  'inscription-linear': inscribedGlaze('linear'),
  'porcelain-flat': patchGraph(COMPOSITION_EXAMPLES.porcelain.create(), {porcelainDepth: {value: 0}}),
  'weathered-flat': patchGraph(COMPOSITION_EXAMPLES.weathered.create(), {weatherDepth: {value: 0}}),
  // Explicit extended palette values clamp at the paint boundary. Their
  // rendering must equal the corresponding in-gamut canonical palette exactly.
  'palette-clipped': surface.paint('carapace', {palette: {
    base: color.linear([2, -1, 0]), shadow: color.linear([-1, 2, -1]), light: color.linear([-1, 0, 2]),
  }}),
  'palette-reference': surface.paint({...splitRecipe('carapace'),
    palette: {base: color.srgb('#ff0000'), shadow: color.srgb('#00ff00'), light: color.srgb('#0000ff')}}),
};

// Optional real optimizer outputs join the same shader assembly, material
// binding and native rendering path as the original regression specimens.
const optimizationPairs = [];
if (process.env.MOONWEAVE_OPTIMIZATION_CASES) {
  const directory = resolve(process.env.MOONWEAVE_OPTIMIZATION_CASES);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'cases.json'), 'utf8'));
  assert.equal(manifest.version, 1, 'Unsupported optimization fixture manifest.');
  assert(Array.isArray(manifest.cases) && manifest.cases.length > 0, 'Expected optimization cases.');
  for (const fixture of manifest.cases) {
    assert.match(fixture.id, /^[a-z][a-z0-9-]{0,63}$/);
    const pair = {id: fixture.id, label: fixture.label, sourceSHA256: {}};
    for (const side of ['before', 'after']) {
      const name = `optimization-${fixture.id}-${side}`;
      assert(!Object.hasOwn(graphs, name), `Duplicate optimization fixture ${name}.`);
      const source = readFileSync(resolve(directory, fixture[side]), 'utf8');
      graphs[name] = parseGraph(source);
      pair[side] = name;
      pair.sourceSHA256[side] = createHash('sha256').update(source).digest('hex');
    }
    optimizationPairs.push(pair);
  }
}

function expand(source, chunks) {
  return source.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name) => {
    if (!(name in chunks)) throw new Error(`Missing shader chunk ${name}`);
    return expand(chunks[name], chunks);
  });
}

function assemble(engine, handle, coordinates, label) {
  const shader = {vertexShader: engine.ShaderLib.physical.vertexShader, fragmentShader: engine.ShaderLib.physical.fragmentShader, uniforms: {}};
  handle.material.onBeforeCompile(shader);
  const captured = {};
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    createProgram: () => ({}), createShader: type => ({type}),
    shaderSource: (stage, source) => { captured[stage.type === 0x8b31 ? 'vertex' : 'fragment'] = source; },
    compileShader() {}, attachShader() {}, linkProgram() {}, bindAttribLocation() {}, deleteShader() {},
  };
  const parameters = {
    defines: handle.material.defines, shaderType: 'MeshPhysicalMaterial', shaderName: 'MoonweaveNativeValidation',
    vertexShader: expand(shader.vertexShader, engine.ShaderChunk), fragmentShader: expand(shader.fragmentShader, engine.ShaderChunk),
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
  // Use each supported engine's own WebGL2 assembler and physical chunks.
  const Assembler = engine === Legacy ? LegacyWebGLProgram : WebGLProgram;
  new Assembler({getContext: () => gl, debug: {checkShaderErrors: false}}, 'native-validation', parameters, {});
  const diagnostic = process.env.MOONWEAVE_NATIVE_DIAGNOSTIC;
  const expression = diagnostic === 'normal' ? 'normal * 0.5 + 0.5'
    : diagnostic === 'paint' ? 'mwSurface.color'
    : diagnostic === 'position' ? 'vMoonweavePosition * 0.4 + 0.5' : null;
  if (expression) {
    const end = captured.fragment.lastIndexOf('}');
    captured.fragment = captured.fragment.slice(0, end) + `gl_FragColor = vec4(${expression}, 1.0);\n` + captured.fragment.slice(end);
  }
  const end = captured.fragment.lastIndexOf('}');
  captured.fragment = captured.fragment.slice(0, end) + `
    if (any(isnan(gl_FragColor)) || any(isinf(gl_FragColor))
      || any(isnan(normal)) || any(isinf(normal))
      || any(isnan(mwSurface.color)) || any(isinf(mwSurface.color))
      || any(isnan(mwSurface.slope)) || any(isinf(mwSurface.slope))) {
      gl_FragColor = vec4(1.0, 0.0, 1.0, 0.5);
    }
  ` + captured.fragment.slice(end);
  return {engine: engine.REVISION, coordinates, label, ...captured};
}

const systems = new Map([[Legacy, createTexturingSystem(Legacy)], [THREE, createTexturingSystem(THREE)]]);
const programs = [], programKeys = new Map(), renderMaterials = [];
for (const [engine, system] of systems) for (const coordinates of ['local', 'attribute']) {
  for (const [name, graph] of Object.entries(graphs)) {
    const handle = system.createMaterial(graph, {coordinates});
    if (name === 'patched') {
      // Exercise a live patch after initial shader binding. The reference case
      // is independently created from the edited graph and must render identically.
      const initialShader = {vertexShader: engine.ShaderLib.physical.vertexShader,
        fragmentShader: engine.ShaderLib.physical.fragmentShader, uniforms: {}};
      handle.material.onBeforeCompile(initialShader);
      handle.patch(liveEdits);
    }
    const key = `${engine.REVISION}:${handle.material.customProgramCacheKey()}`;
    if (!programKeys.has(key)) {
      const id = `p${programs.length}`;
      programKeys.set(key, id);
      programs.push({id, ...assemble(engine, handle, coordinates, name)});
    }
    if (engine === THREE && coordinates === 'attribute') renderMaterials.push({name, handle, program: programKeys.get(key)});
    else handle.dispose();
  }
}

const specimenKind = process.env.MOONWEAVE_NATIVE_SPECIMEN || 'sphere';
let geometry;
if (specimenKind === 'sphere') {
  geometry = new THREE.SphereGeometry(1, 80, 48);
  bindSurfaceCoordinates(THREE, geometry);
} else {
  const specimen = createSpecimen(specimenKind, null);
  const parts = specimen.group.children.map(mesh => mesh.geometry.clone().applyMatrix4(mesh.matrix));
  geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  specimen.dispose();
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationY(-.32));
}
const attributes = Object.fromEntries(Object.entries(geometry.attributes).map(([name, attribute]) => [name, {size: attribute.itemSize, data: Array.from(attribute.array)}]));
const cases = [];
for (const {name, handle, program} of renderMaterials) {
  const shader = {vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}};
  handle.material.onBeforeCompile(shader);
  const artistic = {}, resources = [];
  for (const [key, uniform] of Object.entries(shader.uniforms)) {
    const value = uniform.value;
    if (value?.isTexture) {
      if (!key.includes('_sampler2D_')) continue;
      assert.equal(value.type, THREE.FloatType);
      assert.equal(value.magFilter, THREE.NearestFilter);
      assert.equal(value.minFilter, THREE.NearestFilter);
      assert.equal(value.generateMipmaps, false);
      assert.equal(value.flipY, false);
      assert.equal(value.colorSpace, THREE.NoColorSpace);
      const {width, height, data} = value.image;
      assert(data instanceof Float32Array);
      assert.equal(data.length, width * height * 4);
      assert.equal(value.mipmaps[0].data, data);
      assert.equal(value.mipmaps.at(-1).width, 1);
      assert.equal(value.mipmaps.at(-1).height, 1);
      artistic[key] = 3 + resources.length;
      resources.push({uniform: key, levels: encodeImageLevels(value.mipmaps)});
      continue;
    }
    artistic[key] = value?.isColor ? [value.r, value.g, value.b] : value?.toArray ? value.toArray() : value;
  }
  const distances = specimenKind === 'sphere' ? [3.8, 8] : [6.5, 11];
  for (const distance of distances) {
    const camera = new THREE.PerspectiveCamera(36, 1, .1, 100);
    camera.position.z = distance; camera.updateMatrixWorld();
    cases.push({name: `${name}-${distance === distances[0] ? 'near' : 'far'}`, program, resources, uniforms: {
      ...artistic,
      modelMatrix: new THREE.Matrix4().elements, modelViewMatrix: camera.matrixWorldInverse.elements,
      viewMatrix: camera.matrixWorldInverse.elements, projectionMatrix: camera.projectionMatrix.elements,
      normalMatrix: new THREE.Matrix3().elements, cameraPosition: [0, 0, distance], isOrthographic: 0,
      diffuse: [1, 1, 1], emissive: [0, 0, 0], roughness: handle.material.roughness,
      metalness: handle.material.metalness, opacity: handle.material.opacity, clearcoat: 1, clearcoatRoughness: .4,
      specularIntensity: 1, specularColor: [1, 1, 1], ior: 1.5, toneMappingExposure: 1.2,
      ambientLightColor: [1.1, 1.2, 1.3], receiveShadow: 0,
      'directionalLights[0].direction': new THREE.Vector3(-.6, .8, 1).normalize().toArray(),
      'directionalLights[0].color': [3.2, 3, 2.8], uMwTop: 0, uMwWall: 1, dfgLUT: 2,
    }});
  }
}
const system = systems.get(THREE), pair = system.fields.ensure(), dfg = getDFGLUT().image.data;
const sourceFiles = readdirSync(new URL('../src', import.meta.url), {recursive: true})
  .filter(name => /\.(?:mjs|mts)$/.test(name) && !name.endsWith('.d.mts')).sort();
const sourceSHA256 = Object.fromEntries(sourceFiles.map(name => [
  `src/${name}`, createHash('sha256').update(readFileSync(new URL(`../src/${name}`, import.meta.url))).digest('hex'),
]));
for (const name of ['lab/composition.mts', 'lab/surface-examples.mts', 'lab/painterly-examples.mts', 'lab/application-examples.mts', 'lab/specimens.mjs', 'tools/validate-texturing-gpu.mjs', 'tools/validate-texturing-gpu.py', 'tools/procedural-probes.mjs', 'tools/differential-probes.mjs', 'tools/resource-probes.mjs']) {
  sourceSHA256[name] = createHash('sha256').update(readFileSync(new URL(`../${name}`, import.meta.url))).digest('hex');
}
const probes = proceduralProbes();
programs.push(probes.program);
const colorGroups = colorProbes();
programs.push(...colorGroups.map(group => group.program));
const differentialGroups = differentialProbes();
programs.push(...differentialGroups.map(group => group.program));
const resourceGroups = resourceProbes();
programs.push(...resourceGroups.map(group => group.program));
process.stdout.write(JSON.stringify({
  specimen: specimenKind,
  sourceSHA256,
  provenance: 'Generated graph shaders patched into actual Three r140/r187 physical chunks, each engine using its own WebGL2 WebGLProgram assembler. Generated color values, analytic height differentials and explicit mip-filtered float-image values/derivatives also sampled against the CPU interpreter. Native GLES3 validation, not browser rendering.',
  programs, attributes, indices: Array.from(geometry.index.array), cases,
  ...(optimizationPairs.length ? {optimizationPairs} : {}),
  channelOverrideComposition,
  proceduralProbes: {cases: probes.cases, tolerance: probes.tolerance, program: probes.program.id},
  colorProbes: colorGroups.map(group => ({cases: group.cases, tolerance: group.tolerance, program: group.program.id})),
  differentialProbes: differentialGroups.map(group => ({cases: group.cases, tolerance: group.tolerance, program: group.program.id})),
  resourceProbes: resourceGroups.map(group => ({cases: group.cases, tolerance: group.tolerance, program: group.program.id, kind: group.kind})),
  textures: {resolution: system.fields.resolution,
    top: Buffer.from(pair.top.image.data).toString('base64'), wall: Buffer.from(pair.wall.image.data).toString('base64'),
    dfg: Buffer.from(dfg.buffer, dfg.byteOffset, dfg.byteLength).toString('base64')},
}));
geometry.dispose(); for (const owner of systems.values()) owner.dispose();

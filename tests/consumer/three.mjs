import assert from 'node:assert/strict';
import * as THREE from 'three';
import {named, facets, surface, scalar, color, image, materialGraph, compileGraph} from '@moonweave/surfaces/core';
import {createPaintTextures, createTexturingSystem, bindSurfaceCoordinates} from '@moonweave/surfaces/three';

// Supplied pixels avoid an atlas-generation benchmark in this package gate.
const fields = createPaintTextures(THREE, {
  topData: new Uint8Array(512 * 512 * 4), wallData: new Uint8Array(512 * 512 * 4),
});
const system = createTexturingSystem(THREE, {fields});
const grain = named('grain', scalar.noise({seed: 0xffffffff}));
const proceduralGraph = materialGraph(surface.channels(surface.material(color.mix(
  named('dark', color.srgb('#284d58')), color.linear([.6, .8, .9]), grain,
)), {roughness: grain}));
const procedural = system.createMaterial(proceduralGraph);
assert.equal(procedural.plan.cost.proceduralSamples, 1);
assert.equal(procedural.plan.cost.textureReads, 0);
assert.equal(fields.stats.builds.length, 0, 'procedural materials do not allocate paint atlases');
assert.equal(fields.top, null);
assert.equal(fields.wall, null);
const proceduralShader = {...THREE.ShaderLib.physical, uniforms: {}};
procedural.material.onBeforeCompile(proceduralShader);
assert.match(proceduralShader.fragmentShader, /mwNoise\(/);
assert.equal(Object.hasOwn(proceduralShader.uniforms, 'uMwTop'), false);
assert.equal(Object.hasOwn(proceduralShader.uniforms, 'uMwWall'), false);
const proceduralProgram = procedural.material.customProgramCacheKey();
procedural.patch({grain: {seed: 41}, dark: {value: [.1, .2, .3]}});
assert.equal(procedural.material.customProgramCacheKey(), proceduralProgram);
assert.equal(fields.stats.builds.length, 0);

// A package consumer can share filtered color/channel readers and replace their
// complete image revision without changing the program or sampler uniform slot.
const pixels = named('controlAtlas', image.generate({width: 5, height: 3, channels: 3},
  (u, v) => [u * v, u * (1 - v), .2 + .4 * v]));
const sampling = {filter: 'anisotropic', address: 'zero'};
const imageGraph = materialGraph(surface.bump(surface.channels(
  surface.material(color.image(pixels, sampling)),
  {roughness: scalar.image(pixels, {...sampling, channel: 'r'})},
), scalar.multiply(.002, scalar.image(pixels, {...sampling, channel: 'g'}))));
const imageHandle = system.createMaterial(imageGraph);
const imageShader = {...THREE.ShaderLib.physical, uniforms: {}};
imageHandle.material.onBeforeCompile(imageShader);
const imageBinding = Object.entries(imageShader.uniforms).find(([_key, slot]) => slot.value?.name === 'Moonweave image field');
assert(imageBinding, 'the installed adapter binds the owned image resource');
const [imageUniform, imageSlot] = imageBinding;
const imageTexture = imageSlot.value;
assert.equal(imageTexture.type, THREE.FloatType);
assert.equal(imageTexture.minFilter, THREE.NearestFilter);
assert.equal(imageTexture.generateMipmaps, false);
assert.deepEqual(imageTexture.mipmaps.map(level => [level.width, level.height]), [[5, 3], [2, 1], [1, 1]]);
assert.equal(imageHandle.plan.cost.textureReads, 64, 'all readers share one bounded anisotropic reconstruction');
assert.equal(fields.stats.builds.length, 0, 'filtered images do not allocate the facet atlas');
const imageProgram = imageHandle.material.customProgramCacheKey();
let releasedImages = 0;
imageTexture.addEventListener('dispose', () => releasedImages++);
imageHandle.patch({controlAtlas: {resource: {width: 8, height: 4, channels: 1, data: Array(32).fill(.375)}}});
assert.equal(imageHandle.material.customProgramCacheKey(), imageProgram);
assert.equal(imageShader.uniforms[imageUniform], imageSlot);
assert.notEqual(imageSlot.value, imageTexture);
assert.deepEqual(imageSlot.value.mipmaps.map(level => [level.width, level.height]), [[8, 4], [4, 2], [2, 1], [1, 1]]);
assert.equal(releasedImages, 1);
imageSlot.value.addEventListener('dispose', () => releasedImages++);
imageHandle.dispose();
assert.equal(releasedImages, 2);

const field = named('field', facets());
const gain = named('gain', scalar.parameter(.7));
const graph = materialGraph(surface.mix(surface.paint(field), surface.paint(field, 'horn'), gain));
const handle = system.createMaterial(graph, {coordinates: 'attribute'});
assert.equal(handle.graph, graph);
assert.equal(handle.plan, compileGraph(graph));

const shader = {...THREE.ShaderLib.physical, uniforms: {}};
handle.material.onBeforeCompile(shader);
const program = handle.material.customProgramCacheKey();
const version = handle.material.version;
const structure = handle.plan.structure;
const uniforms = {...shader.uniforms};
handle.patch({gain: {value: .4}});
assert.equal(handle.plan.structure, structure);
assert.equal(handle.material.customProgramCacheKey(), program);
assert.equal(handle.material.version, version);
for (const [name, uniform] of Object.entries(uniforms)) assert.equal(shader.uniforms[name], uniform);

const gradient = named('gradient', color.ramp(grain, [
  [0, color.srgb('#345678')], [.4, color.srgb('#789abc')], [1, color.srgb('#bcdedc')],
], {space: 'oklab', interpolation: 'smoothstep'}));
const paletteHandle = system.createMaterial(surface.paint(field, 'carapace', {base: gradient, shadow: gradient}));
const paletteShader = {...THREE.ShaderLib.physical, uniforms: {}};
paletteHandle.material.onBeforeCompile(paletteShader);
const paletteProgram = paletteHandle.material.customProgramCacheKey();
const paletteUniforms = {...paletteShader.uniforms};
assert.equal(paletteHandle.plan.cost.proceduralSamples, 1);
assert.equal(paletteHandle.plan.cost.paintSamples, 1);
paletteHandle.patch({gradient: {positions: [-.5, .6, 1.5]}, grain: {seed: 43}});
assert.equal(paletteHandle.material.customProgramCacheKey(), paletteProgram);
for (const [name, uniform] of Object.entries(paletteUniforms)) assert.equal(paletteShader.uniforms[name], uniform);

const geometry = new THREE.SphereGeometry(1, 8, 8);
bindSurfaceCoordinates(THREE, geometry);
assert.equal(geometry.getAttribute('aMoonweavePosition').count, geometry.getAttribute('position').count);
assert.equal(geometry.getAttribute('aMoonweaveNormal').count, geometry.getAttribute('normal').count);
geometry.dispose();
system.dispose();
assert.equal(fields.disposed, false, 'the caller retains ownership of borrowed atlases');
fields.dispose();
assert.equal(fields.disposed, true);

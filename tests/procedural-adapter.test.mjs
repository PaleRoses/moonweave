import test from 'node:test';
import assert from 'node:assert/strict';
import * as Current from 'three';
import * as Legacy from 'three-legacy';
import {color, scalar, surface, named, compileGraph, materialGraph} from '../src/core.mjs';
import {createTexturingSystem} from '../src/three.mjs';
import {createPaintTextures} from '../src/three/textures.mts';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {graphUniformValues} from '../src/three/uniforms.mts';

const shaderFor = (THREE, handle) => {
  const shader = {vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}};
  handle.material.onBeforeCompile(shader);
  return shader;
};
function mottled() {
  const field = named('grain', scalar.noise({seed: 0xffffffff}));
  return surface.channels(surface.material(color.mix(
    named('dark', color.srgb('#18443a')), color.srgb('#c8cc83'), field,
  )), {roughness: scalar.add(.35, scalar.multiply(.5, field))});
}

test('procedural work is shared across color and finish, with no atlas dependency', () => {
  const plan = compileGraph(mottled()), code = generateSurfaceShader(plan);
  assert.deepEqual(plan.cost, {paintSamples: 0, proceduralSamples: 1, textureReads: 0, uniformScalars: 7});
  assert.equal(plan.nodes.filter(node => node.kind === 'noise').length, 1);
  assert.equal((code.evaluate.match(/= mwNoise\(/g) ?? []).length, 1);
  assert(!code.declarations.includes('sampler2D'));
  assert(!code.declarations.includes('mwSample('));
  assert(!code.declarations.includes('mwPaint('));
  assert(!generateSurfaceShader(compileGraph(surface.paint('horn'))).declarations.includes('mwNoise('));
});

test('color identities remove unused procedural work without freezing live masks', () => {
  const base = color.srgb('#8ca672'), unused = color.mix(color.srgb('#aa0000'), color.srgb('#0033aa'), scalar.noise());
  for (const weight of [-1, 0]) {
    const plan = compileGraph(surface.material(color.mix(base, unused, weight)));
    assert.equal(plan.cost.proceduralSamples, 0);
    assert.equal(plan.nodes.filter(node => node.kind === 'color').length, 1);
  }
  const same = compileGraph(surface.material(color.mix(base, base, scalar.noise())));
  assert.equal(same.cost.proceduralSamples, 0);
  const live = compileGraph(surface.material(color.mix(base, unused, scalar.parameter(0))));
  assert.equal(live.cost.proceduralSamples, 1);
  assert(live.nodes.some(node => node.kind === 'colorMix'));
});

test('procedural shader budget applies after dead work is removed', () => {
  const noise = Array.from({length: 17}, (_, seed) => scalar.noise({seed}));
  const expression = noise.reduce((a, b) => scalar.add(a, b));
  const over = surface.material(color.mix(color.linear([0, 0, 0]), color.linear([1, 1, 1]), expression));
  assert.throws(() => generateSurfaceShader(compileGraph(over)), /16 procedural fields/);
  assert.doesNotThrow(() => generateSurfaceShader(compileGraph(
    surface.mix(surface.material(color.linear([.2, .3, .4])), over, 0),
  )));
});

for (const THREE of [Legacy, Current]) {
  test(`r${THREE.REVISION}: zero-facet materials allocate no atlas; entering paint acquires it once`, () => {
    const fields = createPaintTextures(THREE, {resolution: 512,
      topData: new Uint8Array(512 * 512 * 4), wallData: new Uint8Array(512 * 512 * 4)});
    let acquisitions = 0;
    const borrowed = {...fields, ensure() {acquisitions++; return fields.ensure();}};
    const system = createTexturingSystem(THREE, {fields: borrowed});
    const handle = system.createMaterial(mottled()), graph = handle.graph;
    const originalKey = handle.material.customProgramCacheKey();
    const procedural = shaderFor(THREE, handle);
    assert.equal(acquisitions, 0);
    assert.equal(fields.stats.builds.length, 0);
    assert(!Object.hasOwn(procedural.uniforms, 'uMwTop'));
    handle.setGraph(surface.mix(mottled(), surface.paint('carapace'), .5));
    assert.equal(acquisitions, 1);
    const hybrid = shaderFor(THREE, handle), atlas = hybrid.uniforms.uMwTop;
    assert(atlas.value.isTexture);
    handle.setGraph(graph);
    assert.equal(handle.material.customProgramCacheKey(), originalKey);
    assert.equal(shaderFor(THREE, handle).uniforms.uMwTop, atlas);
    handle.setGraph(surface.paint('horn'));
    assert.equal(acquisitions, 1);
    system.dispose(); fields.dispose();
  });

  test(`r${THREE.REVISION}: seed and color patches keep programs and uniform slots stable`, () => {
    const system = createTexturingSystem(THREE), handle = system.createMaterial(mottled());
    const shader = shaderFor(THREE, handle), plan = handle.plan;
    const key = handle.material.customProgramCacheKey(), version = handle.material.version;
    const slots = {...shader.uniforms};
    handle.patch({grain: {seed: 1234567890}, dark: {value: [.2, .4, .6]}});
    assert.equal(handle.plan.structure, plan.structure);
    assert.equal(handle.material.customProgramCacheKey(), key);
    assert.equal(handle.material.version, version);
    for (const binding of graphUniformValues(handle.plan)) {
      assert.equal(shader.uniforms[binding.name], slots[binding.name]);
      const value = shader.uniforms[binding.name].value;
      assert.deepEqual(typeof value === 'number' ? value : value.toArray(), binding.value);
    }
    const seed = graphUniformValues(handle.plan).find(binding => binding.type === 'uint');
    assert.equal(shader.uniforms[seed.name].value, 1234567890);
    assert.equal(system.fields.stats.builds.length, 0);
    system.dispose();
  });

  test(`r${THREE.REVISION}: failed texture acquisition and invalid opacity leave a procedural material intact`, () => {
    const fields = createPaintTextures(THREE), error = new Error('atlas unavailable');
    const system = createTexturingSystem(THREE, {fields: {...fields, ensure() {throw error;}}});
    const handle = system.createMaterial(mottled()), shader = shaderFor(THREE, handle);
    const plan = handle.plan, key = handle.material.customProgramCacheKey(), version = handle.material.version;
    assert.throws(() => handle.setGraph(surface.paint('horn')), candidate => candidate === error);
    assert.throws(() => handle.setGraph(surface.channels(surface.material(color.linear([1, 0, 0])), {opacity: .5})), /transparent:true/);
    assert.equal(handle.plan, plan);
    assert.equal(handle.material.customProgramCacheKey(), key);
    assert.equal(handle.material.version, version);
    assert(!Object.hasOwn(shader.uniforms, 'uMwTop'));
    assert.deepEqual(materialGraph(handle.graph), plan.graph);
    system.dispose(); fields.dispose();
  });
}

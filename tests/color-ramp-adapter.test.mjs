import test from 'node:test';
import assert from 'node:assert/strict';
import * as Current from 'three';
import * as Legacy from 'three-legacy';
import {color, scalar, surface, named, compileGraph, PALETTE_KEYS} from '../src/core.mjs';
import {createTexturingSystem} from '../src/three.mjs';
import {createPaintTextures} from '../src/three/textures.mts';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {graphUniformValues} from '../src/three/uniforms.mts';

function coloredPaint(space = 'oklab') {
  const field = named('grain', scalar.noise({seed: 37}));
  const pigment = named('pigment', color.ramp(field, [
    [0, named('dark', color.linear([.02, .07, .12]))],
    [.5, color.linear([.1, .4, .3])],
    [1, color.linear([.7, .8, .4])],
  ], {space, interpolation: 'smoothstep'}));
  return surface.channels(named('paint', surface.paint('carapace', {palette: {
    base: pigment, shadow: color.linear([-.2, .05, .12]),
  }})), {roughness: scalar.add(.3, scalar.multiply(.5, field))});
}

const shaderFor = (THREE, handle) => {
  const shader = {vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}};
  handle.material.onBeforeCompile(shader);
  return shader;
};

test('paint palettes use only color graph bindings and share procedural work', () => {
  const plan = compileGraph(coloredPaint()), bindings = graphUniformValues(plan);
  const paint = plan.nodes.find(node => node.kind === 'paint');
  assert.equal(plan.cost.paintSamples, 1);
  assert.equal(plan.cost.proceduralSamples, 1);
  assert.equal(plan.cost.textureReads, 4);
  assert.equal(plan.nodes.filter(node => node.kind === 'noise').length, 1);
  assert.deepEqual(bindings.filter(binding => binding.id === paint.id && PALETTE_KEYS.includes(binding.field)).map(binding => binding.field), []);
  assert.deepEqual(Object.keys(paint.palette), PALETTE_KEYS);
  assert(bindings.some(binding => binding.id === paint.palette.light && binding.type === 'vec3'));
  assert.equal(bindings.filter(binding => binding.field.startsWith('position')).length, 3);
  assert.equal(plan.cost.uniformScalars, bindings.reduce((count, binding) => count + (Array.isArray(binding.value) ? binding.value.length : 1), 1));
});

test('color conversion shader is included only when the live plan uses Oklab', () => {
  const linear = generateSurfaceShader(compileGraph(coloredPaint('linear-rgb')));
  const perceptual = generateSurfaceShader(compileGraph(coloredPaint('oklab')));
  assert(!linear.declarations.includes('mwLinearToOklab'));
  assert(perceptual.declarations.includes('mwLinearToOklab'));
  assert.match(perceptual.evaluate, /mwPaint\([^\n]+clamp\(/);
  assert.match(generateSurfaceShader(compileGraph(surface.material(color.linear([-1, .5, 2])))).evaluate,
    /MoonweaveSurface\(clamp\(/);
});

for (const THREE of [Legacy, Current]) {
  test(`r${THREE.REVISION}: color ramp positions, colors and paint palette edits keep stable bindings`, () => {
    const fields = createPaintTextures(THREE, {resolution: 512,
      topData: new Uint8Array(512 * 512 * 4), wallData: new Uint8Array(512 * 512 * 4)});
    const system = createTexturingSystem(THREE, {fields}), handle = system.createMaterial(coloredPaint());
    const shader = shaderFor(THREE, handle), slots = {...shader.uniforms};
    const key = handle.material.customProgramCacheKey(), version = handle.material.version, plan = handle.plan;
    handle.patch({pigment: {positions: [-.1, .4, 1.2]}, dark: {value: [.12, -.02, 1.3]}, grain: {seed: 123}});
    assert.equal(handle.material.customProgramCacheKey(), key);
    assert.equal(handle.material.version, version);
    assert.equal(handle.plan.structure, plan.structure);
    for (const binding of graphUniformValues(handle.plan)) {
      assert.equal(shader.uniforms[binding.name], slots[binding.name]);
      const value = shader.uniforms[binding.name].value;
      assert.deepEqual(typeof value === 'number' ? value : value.toArray(), binding.value);
    }
    const before = Object.fromEntries(Object.entries(shader.uniforms).map(([name, slot]) => [name,
      slot.value?.toArray ? slot.value.toArray() : slot.value]));
    const lightId = handle.graph.nodes.find(node => node.id === 'paint').palette.light;
    const lightBinding = graphUniformValues(handle.plan).find(binding => binding.id === handle.plan.structure.sourceNodes[lightId]);
    const nextLight = [.9, .6, .3];
    handle.patch({[lightId]: {value: nextLight}});
    for (const [name, slot] of Object.entries(shader.uniforms)) {
      assert.equal(slot, slots[name]);
      assert.deepEqual(slot.value?.toArray ? slot.value.toArray() : slot.value, name === lightBinding.name ? nextLight : before[name]);
    }
    assert.throws(() => handle.patch({paint: {style: {palette: {base: '#ff00ff'}}}}), /Unknown paint style patch property/);
    const stable = handle.plan;
    assert.throws(() => handle.patch({pigment: {positions: [0, 0, 1]}}), /positions|gap|increas/);
    assert.equal(handle.plan, stable);
    assert.equal(fields.stats.builds.length, 1);
    handle.setGraph(coloredPaint('linear-rgb'));
    assert.notEqual(handle.material.customProgramCacheKey(), key);
    handle.setGraph(coloredPaint('oklab'));
    assert.equal(handle.material.customProgramCacheKey(), key);
    for (const [name, slot] of Object.entries(shader.uniforms)) assert.equal(slot, slots[name]);
    system.dispose(); fields.dispose();
  });
}

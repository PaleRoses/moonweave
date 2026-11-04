import test from 'node:test';
import assert from 'node:assert/strict';
import * as Current from 'three';
import * as Legacy from 'three-legacy';
import {scalar, color, surface, domain, named, compileGraph} from '../src/core.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {graphUniformValues} from '../src/three/uniforms.mts';
import {createTexturingSystem} from '../src/three.mjs';

const material = () => surface.material(color.srgb('#d7d3bb'));
const count = (text, pattern) => (text.match(pattern) ?? []).length;

test('height demand derives shared noise once and adds no atlas dependency', () => {
  const grain = named('grain', scalar.noise({seed: 37}));
  const base = surface.channels(surface.material(color.mix(color.srgb('#29334d'), color.srgb('#c9d9c3'), grain)), {
    roughness: scalar.add(.35, scalar.multiply(.4, grain)),
  });
  const plan = compileGraph(surface.bump(base, scalar.multiply(scalar.parameter(.04), grain)));
  const shader = generateSurfaceShader(plan);
  assert.equal(plan.cost.proceduralSamples, 1);
  assert.equal(plan.cost.textureReads, 0);
  assert.equal(count(shader.evaluate, /= mwNoiseSample\(/g), 1);
  assert.equal(count(shader.evaluate, /= mwNoise\(/g), 0);
  assert(!shader.declarations.includes('float mwNoise(vec3'));
  assert(!shader.declarations.includes('sampler2D'));
  assert.match(shader.evaluate, /\.slope \+= mw_n\d+_d;/);
  assert.equal(count(shader.evaluate, /dFdx\(vMoonweavePosition\)/g), 1);
  assert(!shader.evaluate.includes('dFdx(mw_'));
  assert(!shader.declarations.includes('mwNormalTangent'));
});

test('analytic differential code follows only height ancestors', () => {
  const pigment = scalar.noise({seed: 3}), height = scalar.noise({seed: 7});
  const base = surface.material(color.mix(color.srgb('#29334d'), color.srgb('#c9d9c3'), pigment));
  const code = generateSurfaceShader(compileGraph(surface.bump(base, scalar.multiply(.025, height))));
  assert.equal(count(code.evaluate, /= mwNoiseSample\(/g), 1);
  assert.equal(count(code.evaluate, /= mwNoise\(/g), 1);
  const plain = generateSurfaceShader(compileGraph(base));
  assert(!plain.declarations.includes('mwNoiseSample'));
  assert(!plain.evaluate.includes('dFdx('));
  assert(!plain.evaluate.includes('_d ='));
});

test('uniform height expressions disappear while uniform factors keep value bindings', () => {
  const flat = compileGraph(material());
  const uniform = compileGraph(surface.bump(material(), scalar.ramp(scalar.add(scalar.parameter(2), 3), 0, 1)));
  assert.equal(uniform.programKey, flat.programKey);
  assert.equal(uniform.cost.uniformScalars, flat.cost.uniformScalars);
  assert(!generateSurfaceShader(uniform).evaluate.includes('dFdx('));
  const amount = named('amount', scalar.parameter(0));
  const varying = compileGraph(surface.bump(material(), scalar.multiply(amount, scalar.axis('x'))));
  assert(varying.nodes.some(node => node.kind === 'bump'));
  const slot = varying.bindings.find(binding => binding.sourceId === 'amount');
  const code = generateSurfaceShader(varying).evaluate;
  assert(!code.includes(`vec2 mw_${slot.nodeId}_d`));
  assert.equal(varying.cost.uniformScalars, flat.cost.uniformScalars + 1);
});

test('normal-dependent heights apply the normalized inverse-transpose differential chain', () => {
  const frame = domain.transform([1.5, .25, 0, 0, 0, .5, .25, 0, .125, 0, 2, 0, 0, 0, 0, 1]);
  const code = generateSurfaceShader(compileGraph(surface.bump(material(), scalar.facing([.25, 1, -.5], frame, true))));
  assert.match(code.evaluate, /mwNormalTangent\(vMoonweaveNormal, mwRootNormal, dFdx\(vMoonweaveNormal\)\)/);
  assert.match(code.evaluate, /= mwTransformNormalSample\(/);
  assert.match(code.evaluate, /sign\(dot\(/);
  assert(!code.evaluate.includes('dFdx(vMoonweavePosition)'));
});

for (const THREE of [Legacy, Current]) {
  test(`r${THREE.REVISION}: signed live height edits retain shader, slots and zero-atlas ownership`, () => {
    const frame = named('frame', domain.transform([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]));
    const grain = named('grain', scalar.noise({seed: 37, domain: frame}));
    const amount = named('amount', scalar.parameter(.035));
    const input = surface.bump(material(), scalar.multiply(amount, grain));
    const system = createTexturingSystem(THREE), handle = system.createMaterial(input);
    const shader = {vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}};
    handle.material.onBeforeCompile(shader);
    const slots = {...shader.uniforms}, plan = handle.plan, key = handle.material.customProgramCacheKey();
    const version = handle.material.version;
    for (const value of [0, -.05, .08]) {
      handle.patch({amount: {value}, grain: {seed: value === 0 ? 0xffffffff : 7}});
      assert.equal(handle.plan.structure, plan.structure);
      assert.equal(handle.material.customProgramCacheKey(), key);
      assert.equal(handle.material.version, version);
      for (const binding of graphUniformValues(handle.plan)) {
        const slot = shader.uniforms[binding.name];
        assert.equal(slot, slots[binding.name]);
        assert.deepEqual(slot.value?.toArray ? slot.value.toArray() : slot.value, binding.value);
      }
    }
    assert.equal(system.fields.stats.builds.length, 0);
    assert(!Object.hasOwn(shader.uniforms, 'uMwTop'));
    assert.match(shader.fragmentShader, /\.slope \+= mw_n\d+_d;/);
    assert.match(shader.fragmentShader, /normal = moonweaveNormal\(/);
    system.dispose();
  });
}

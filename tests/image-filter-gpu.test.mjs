import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as Legacy from 'three-legacy';
import {image, color, scalar, surface, domain, named, compileGraph} from '../src/core.mjs';
import {createTexturingSystem} from '../src/three.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';

const source = () => named('pixels', image.generate({width: 17, height: 9, channels: 3},
  (u, v, x, y) => [u * v, (x + y) % 2, .25 + .5 * u]));
const shaderOf = (engine, handle) => {
  const shader = {vertexShader: engine.ShaderLib.physical.vertexShader,
    fragmentShader: engine.ShaderLib.physical.fragmentShader, uniforms: {}};
  handle.material.onBeforeCompile(shader);
  return shader;
};
const textureOf = (engine, handle) => Object.values(shaderOf(engine, handle).uniforms)
  .map(slot => slot.value).find(value => value?.isTexture && value.name === 'Moonweave image field');

test('both supported Three engines share one complete explicit pyramid across sampling policies', () => {
  for (const engine of [THREE, Legacy]) {
    const system = createTexturingSystem(engine), pixels = source();
    const linear = system.createMaterial(surface.material(color.image(pixels)));
    const filtered = system.createMaterial(surface.material(color.image(pixels, {
      filter: 'anisotropic', address: 'zero',
    })));
    const texture = textureOf(engine, linear);
    assert.equal(textureOf(engine, filtered), texture);
    assert.equal(texture.minFilter, engine.NearestFilter);
    assert.equal(texture.magFilter, engine.NearestFilter);
    assert.equal(texture.generateMipmaps, false);
    assert.equal(texture.image.data, texture.mipmaps[0].data);
    assert.deepEqual(texture.mipmaps.map(level => [level.width, level.height]),
      [[17, 9], [8, 4], [4, 2], [2, 1], [1, 1]]);
    const expected = [0, 1, 2].map(channel => pixels.resource.data
      .filter((_, i) => i % 3 === channel).reduce((a, b) => a + b, 0) / (17 * 9));
    const mean = texture.mipmaps.at(-1).data;
    for (let channel = 0; channel < 3; channel++) assert(Math.abs(mean[channel] - expected[channel]) < 1e-7);
    for (const level of texture.mipmaps) {
      assert(level.data instanceof Float32Array);
      assert.equal(level.data.length, level.width * level.height * 4);
      for (let i = 3; i < level.data.length; i += 4) assert.equal(level.data[i], 1);
    }
    let disposed = 0;
    texture.addEventListener('dispose', () => disposed++);
    filtered.dispose();
    assert.equal(disposed, 0);
    linear.dispose();
    assert.equal(disposed, 1);
    system.dispose();
  }
});

test('resource dimension edits replace the pyramid while retaining shader and binding identity', () => {
  const system = createTexturingSystem(THREE), pixels = source();
  const handle = system.createMaterial(surface.bump(surface.material(color.image(pixels, {
    filter: 'trilinear', address: 'zero',
  })), scalar.image(pixels, {filter: 'anisotropic', address: 'zero', channel: 'g'})));
  const old = textureOf(THREE, handle), shader = shaderOf(THREE, handle);
  const slot = Object.values(shader.uniforms).find(binding => binding.value === old);
  const key = handle.material.customProgramCacheKey();
  let disposed = 0;
  old.addEventListener('dispose', () => disposed++);
  handle.patch({pixels: {resource: {width: 1, height: 1, channels: 1, data: [.375]}}});
  const current = textureOf(THREE, handle);
  assert.notEqual(current, old);
  assert.equal(slot.value, current);
  assert.equal(current.mipmaps.length, 1);
  assert.deepEqual(Array.from(current.mipmaps[0].data), [.375, .375, .375, 1]);
  assert.equal(handle.material.customProgramCacheKey(), key);
  assert.equal(disposed, 1);
  system.dispose();
});

test('filtered RGB, finish and height readers share one bounded reconstruction', () => {
  for (const [filter, reads] of [['trilinear', 8], ['anisotropic', 64]]) {
    const pixels = source(), options = {filter, address: 'zero'};
    const r = scalar.image(pixels, {...options, channel: 'r'});
    const g = scalar.image(pixels, {...options, channel: 'g'});
    const b = scalar.image(pixels, {...options, channel: 'b'});
    const plan = compileGraph(surface.bump(surface.channels(surface.material(color.image(pixels, options)),
      {roughness: r, metalness: g, clearcoat: b}), scalar.add(g, b)));
    const shader = generateSurfaceShader(plan);
    assert.equal(plan.cost.textureReads, reads);
    assert.equal(shader.evaluate.match(/\bmwImageFiltered\(/g)?.length, 1);
    assert.match(shader.evaluate, /dFdx\(vMoonweavePosition\)/);
    assert.match(shader.evaluate, /dFdy\(vMoonweavePosition\)/);
    assert.match(shader.declarations, /texelFetch\(source, ivec2\(bounded\), level\)/);
    assert.match(shader.declarations, /highp sampler2D/);
  }
});

test('filter identity and addressing prevent inappropriate sample fusion', () => {
  const pixels = source();
  const plan = compileGraph(surface.channels(surface.material(color.image(pixels)), {
    roughness: scalar.image(pixels, {filter: 'trilinear'}),
    metalness: scalar.image(pixels, {filter: 'anisotropic'}),
    clearcoat: scalar.image(pixels, {filter: 'anisotropic', address: 'zero'}),
  }));
  const shader = generateSurfaceShader(plan);
  assert.equal(plan.cost.textureReads, 4 + 8 + 64 + 64);
  assert.equal(shader.evaluate.match(/\bmwImage\(/g)?.length, 1);
  assert.equal(shader.evaluate.match(/\bmwImageFiltered\(/g)?.length, 3);
  assert.equal(plan.nodes.filter(node => node.kind === 'image').length, 1);
});

test('color-only filters demand affine footprint tangents without adding height fields', () => {
  const frame = domain.transform([2, 0, 0, 0, .5, 3, 0, 0, 0, 0, 1, 0, .1, -.1, 0, 1]);
  const plan = compileGraph(surface.material(color.image(source(), {
    filter: 'anisotropic', address: 'repeat', domain: frame,
  })));
  const shader = generateSurfaceShader(plan), transformed = plan.nodes.find(node => node.kind === 'transform');
  assert.match(shader.evaluate, /dFdx\(vMoonweavePosition\)/);
  assert.match(shader.evaluate, new RegExp(`vec3 mw_${transformed.id}_px = mat3`));
  assert.match(shader.evaluate, new RegExp(`vec3 mw_${transformed.id}_py = mat3`));
  assert.equal(plan.nodes.some(node => node.kind === 'bump'), false);
});

test('base-level zero extension requires no screen footprint or mip choice', () => {
  const shader = generateSurfaceShader(compileGraph(surface.material(color.image(source(), {address: 'zero'}))));
  assert.match(shader.evaluate, /mwImageLevel\([^\n]+, 0, 2,/);
  assert.doesNotMatch(shader.evaluate, /mwImageFiltered\(|dFdx\(|dFdy\(/);
});

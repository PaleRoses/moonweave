import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  image, color, scalar, surface, domain, named, instantiate, inDomain,
  materialGraph, expressionGraph, graphExpression, parseGraph, parseExpressionGraph, serializeGraph,
  patchGraph, compileGraph, createFieldSampler, GRAPH_LIMITS,
} from '../src/core.mjs';
import {createTexturingSystem} from '../src/three.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';

const source = () => named('pixels', image.data({width: 2, height: 2, channels: 1, data: [0, .25, .5, .75]}));
const context = {position: [.5, .5, 0], dx: [.1, 0, 0], dy: [0, .1, 0]};
const shaderOf = handle => {
  const shader = {vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}};
  handle.material.onBeforeCompile(shader);
  return shader;
};
const resourceTexture = handle => Object.values(shaderOf(handle).uniforms).map(u => u.value)
  .find(value => value?.isTexture && value.name === 'Moonweave image field');

test('image resources are shared DAG data through serialization, reification and instancing', () => {
  const pixels = source();
  const field = scalar.image(pixels);
  const output = surface.bump(surface.material(color.image(pixels)), field);
  const graph = materialGraph(output), restored = parseGraph(serializeGraph(graph));
  assert.equal(graph.nodes.filter(node => node.kind === 'image').length, 1);
  assert.deepEqual(restored, graph);
  const expression = graphExpression(restored);
  assert.equal(expression.input.color.image, expression.height.image);
  const instanced = instantiate(expression, {prefix: 'wing', shared: [expression.height.image]});
  assert.equal(instanced.height.image, expression.height.image);
  const isolated = instantiate(expression, {prefix: 'tail'});
  assert.equal(isolated.height.image.id, 'tail_pixels');
  assert.equal(isolated.height.image.resource, expression.height.image.resource);
  assert.equal(parseExpressionGraph(serializeGraph(pixels)).nodes[0].kind, 'image');
});

test('image fields carry affine chain derivatives and immutable sampler revisions', () => {
  const pixels = source(), field = named('field', scalar.image(pixels));
  const frame = domain.transform([2, 0, 0, 0, .5, 3, 0, 0, 0, 0, 1, 0, .1, -.1, 0, 1]);
  const sampled = createFieldSampler(inDomain(field, frame))({position: [.15, .15, 0], dx: [.1, .02, 0], dy: [.03, .04, 0]});
  assert(Math.abs(sampled.dx - (.5 * .21 + .06)) < 1e-12);
  assert(Math.abs(sampled.dy - (.5 * .08 + .12)) < 1e-12);
  const graph = expressionGraph(field), oldSample = createFieldSampler(graph);
  const changed = patchGraph(graph, {pixels: {resource: {width: 1, height: 1, channels: 3, data: [.2, .4, .6]}}});
  assert.equal(oldSample(context).value, .375);
  assert.deepEqual(createFieldSampler(changed)(context), {value: Math.fround(.2), dx: 0, dy: 0});
  assert.equal(oldSample(context).value, .375);
  assert(Object.isFrozen(createFieldSampler(color.image(pixels))(context).dx));
});

test('image sorts and structural sampling options reject incoherent graph connections', () => {
  assert.throws(() => expressionGraph(scalar.image(color.srgb('#123456'))), /expects image/);
  assert.throws(() => expressionGraph(color.image(source(), {address: 'mirror'})), /clamp, repeat or zero/);
  assert.throws(() => expressionGraph(scalar.image(source(), {channel: 'a'})), /r, g or b/);
  assert.throws(() => expressionGraph(surface.material(source())), /expects color/);
  assert.throws(() => patchGraph(expressionGraph(named('sample', scalar.image(source()))), {sample: {address: 'repeat'}}), /structural/);
});

test('the graph image budget applies to import and persistent image edits', () => {
  const count = GRAPH_LIMITS.imageComponents;
  const large = {width: 512, height: 512, channels: 1, data: Array(count).fill(0)};
  const a = named('a', image.data(large)), b = named('b', image.data({width: 1, height: 1, channels: 1, data: [0]}));
  assert.throws(() => materialGraph(surface.mix(surface.material(color.image(a)), surface.material(color.image(b)), .5)), /total components/);
  const graph = materialGraph(surface.material(color.image(a)));
  const borrowed = expressionGraph(b).nodes[0];
  assert.throws(() => materialGraph({...graph, nodes: [...graph.nodes, borrowed]}), /total components/);
  assert(serializeGraph(graph).length < GRAPH_LIMITS.jsonBytes);
  assert.deepEqual(parseGraph(serializeGraph(graph)), graph);
  const small = materialGraph(surface.mix(surface.material(color.image(b)), surface.material(color.image(source())), .5));
  assert.throws(() => patchGraph(small, {b: {resource: large}}), /total components/);
});

test('resource pixel edits keep shader identity and update range analysis', () => {
  const pixels = source(), mask = named('mask', scalar.image(pixels));
  const graph = materialGraph(surface.channels(surface.material(color.image(pixels)), {roughness: mask}));
  const before = compileGraph(graph);
  const next = compileGraph(patchGraph(graph, {pixels: {resource: {width: 1, height: 1, channels: 1, data: [.5]}}}));
  assert.equal(next.structure, before.structure);
  assert.equal(next.programKey, before.programKey);
  assert.equal(next.cost.textureReads, 4);
  const id = next.nodes.find(node => node.kind === 'imageScalar').id;
  assert.deepEqual(next.ranges[id], [.5, .5]);
  const glsl = generateSurfaceShader(next);
  assert.match(glsl.declarations, /uniform highp sampler2D/);
  assert.match(glsl.declarations, /mwImage\(highp sampler2D/);
});

test('Three shares resource textures, atomically revises them and releases the final reference', () => {
  const system = createTexturingSystem(THREE), pixels = source();
  const graph = materialGraph(surface.material(color.image(pixels)));
  const first = system.createMaterial(graph), second = system.createMaterial(graph);
  const old = resourceTexture(first), slot = Object.values(shaderOf(first).uniforms).find(u => u.value === old);
  assert.equal(resourceTexture(second), old);
  assert.equal(old.magFilter, THREE.NearestFilter);
  assert.equal(old.type, THREE.FloatType);
  assert.equal(old.generateMipmaps, false);
  let oldReleases = 0;
  old.addEventListener('dispose', () => oldReleases++);
  const key = first.material.customProgramCacheKey();
  first.patch({pixels: {resource: {width: 1, height: 1, channels: 3, data: [.2, .4, .6]}}});
  const fresh = resourceTexture(first);
  assert.notEqual(fresh, old);
  assert.equal(slot.value, fresh);
  assert.equal(first.material.customProgramCacheKey(), key);
  assert.deepEqual(Array.from(fresh.image.data), [Math.fround(.2), Math.fround(.4), Math.fround(.6), 1]);
  assert.equal(oldReleases, 0);
  assert.throws(() => first.patch({pixels: {resource: {width: 0, height: 1, channels: 1, data: []}}}), /width/);
  assert.equal(resourceTexture(first), fresh);
  second.dispose();
  assert.equal(oldReleases, 1);
  let freshReleases = 0;
  fresh.addEventListener('dispose', () => freshReleases++);
  first.setGraph(surface.material(color.srgb('#123456')));
  assert.equal(freshReleases, 1);
  assert.equal(slot.value, null);
  first.setGraph(graph);
  assert.notEqual(resourceTexture(first), old);
  system.dispose();
  assert.equal(oldReleases, 1);
  assert.equal(freshReleases, 1);
});

test('disposing a material clears its cached texture slots while preserving other borrowers', () => {
  const system = createTexturingSystem(THREE);
  const graph = materialGraph(surface.coat(surface.paint(), color.image(source())));
  const first = system.createMaterial(graph), second = system.createMaterial(graph);
  const textureSlots = handle => Object.values(shaderOf(handle).uniforms).filter(slot => slot.value?.isTexture);
  const firstSlots = textureSlots(first), secondSlots = textureSlots(second);
  assert.equal(firstSlots.length, 3, 'two paint atlases and one custom image');
  const textures = firstSlots.map(slot => slot.value), releases = textures.map(() => 0);
  textures.forEach((texture, index) => texture.addEventListener('dispose', () => releases[index]++));
  const imageIndex = textures.findIndex(texture => texture.name === 'Moonweave image field');

  first.dispose();
  assert(firstSlots.every(slot => slot.value === null));
  assert.deepEqual(secondSlots.map(slot => slot.value), textures);
  assert.deepEqual(releases, [0, 0, 0], 'the other material still borrows every texture');
  assert.equal(first.graph, graph, 'disposal preserves the authored document');

  second.dispose();
  assert(secondSlots.every(slot => slot.value === null));
  assert.deepEqual(releases, textures.map((_, index) => Number(index === imageIndex)));
  system.dispose();
  assert.deepEqual(releases, [1, 1, 1]);
  assert.equal(system.fields.top, null);
  assert.equal(system.fields.wall, null);
  assert.equal(system.fields.bytes, 0);
});

test('pigment-only coating preserves the original surface and literal absence specializes away', () => {
  const base = surface.bump(surface.channels(surface.material(color.srgb('#203040')), {roughness: .8, metalness: .3}), scalar.axis('x'));
  const pigment = color.srgb('#e4ba7c');
  assert.equal(compileGraph(surface.coat(base, pigment, 0)).programKey, compileGraph(base).programKey);
  const shader = generateSurfaceShader(compileGraph(surface.coat(base, pigment, scalar.parameter(.6))));
  const coat = shader.evaluate.split('\n').filter(line => line.includes('.color = mix'));
  assert.equal(coat.length, 1);
  assert.match(coat[0], /clamp\(.*0\.0, 1\.0\)/);
  assert(!coat[0].includes('roughness'));
});

test('throwing image disposal listeners do not abandon later resources or leave a stale live plan', () => {
  const makeGraph = () => surface.channels(surface.material(color.image(source())), {
    roughness: scalar.image(image.data({width: 1, height: 1, channels: 1, data: [.6]})),
  });
  for (const operation of ['replace', 'dispose']) {
    const system = createTexturingSystem(THREE), handle = system.createMaterial(makeGraph());
    const slots = Object.values(shaderOf(handle).uniforms).filter(slot => slot.value?.isTexture);
    const textures = slots.map(slot => slot.value);
    const counts = textures.map(() => 0);
    textures.forEach((texture, i) => texture.addEventListener('dispose', () => {
      counts[i]++;
      if (i === 0) throw new Error('consumer listener');
    }));
    let materialReleases = 0;
    handle.material.addEventListener('dispose', () => materialReleases++);
    if (operation === 'replace') {
      const next = materialGraph(surface.material(color.srgb('#123456')));
      assert.throws(() => handle.setGraph(next), /Graph applied/);
      assert.equal(handle.graph, next);
      assert.equal(handle.plan.programKey, compileGraph(next).programKey);
      assert.equal(resourceTexture(handle), undefined);
      system.dispose();
    } else {
      assert.throws(() => system.dispose(), AggregateError);
      assert(handle.disposed);
      system.dispose();
    }
    assert(slots.every(slot => slot.value === null));
    assert.deepEqual(counts, [1, 1]);
    assert.equal(materialReleases, 1);
  }
});

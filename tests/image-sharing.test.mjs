import test from 'node:test';
import assert from 'node:assert/strict';
import {
  image, color, scalar, surface, domain, named, materialGraph, compileGraph, patchGraph, createFieldSampler,
} from '../src/core.mjs';
import {fieldAlgebra, sampleField} from '../src/core/field-evaluate.mts';
import {normalizeImage} from '../src/core/resources.mts';
import {generateSurfaceShader} from '../src/three/shader.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const source = () => image.data({width: 2, height: 2, channels: 3,
  data: [.1, .2, .3, .3, .4, .5, .5, .6, .7, .7, .8, .9]});
const context = {position: [.5, .5, 0], dx: [.125, 0, 0], dy: [0, .25, 0]};
const calls = plan => generateSurfaceShader(plan).evaluate.match(/\bmwImage\(/g)?.length ?? 0;

test('RGB and all scalar channels share four texel reads while keeping independent typed expressions', () => {
  const pixels = source();
  const channels = Object.fromEntries(['r', 'g', 'b'].map(channel => [channel, scalar.image(pixels, {channel})]));
  const output = surface.bump(surface.channels(surface.material(color.image(pixels)), {
    roughness: channels.r, metalness: channels.g, clearcoat: channels.b,
  }), scalar.add(channels.g, channels.b));
  const plan = compileGraph(output);
  assert.equal(plan.nodes.filter(node => node.kind === 'imageScalar').length, 3);
  assert.equal(plan.nodes.filter(node => node.kind === 'imageColor').length, 1);
  assert.equal(plan.cost.textureReads, 4);
  assert.equal(calls(plan), 1);
  const shader = generateSurfaceShader(plan);
  const green = plan.nodes.find(node => node.kind === 'imageScalar' && node.channel === 'g');
  const blue = plan.nodes.find(node => node.kind === 'imageScalar' && node.channel === 'b');
  assert.match(shader.evaluate, new RegExp(`vec2 mw_${green.id}_d =`));
  assert.match(shader.evaluate, new RegExp(`vec2 mw_${blue.id}_d =`));
});

test('reconstruction sharing also works when a height reader is emitted before its color reader', () => {
  const pixels = source();
  const output = surface.mix(
    surface.bump(surface.material(color.srgb('#243546')), scalar.image(pixels, {channel: 'g'})),
    surface.material(color.image(pixels)), .5,
  );
  const plan = compileGraph(output);
  const readers = plan.nodes.filter(node => node.kind === 'imageScalar' || node.kind === 'imageColor');
  assert.equal(readers[0].kind, 'imageScalar');
  assert.equal(plan.cost.textureReads, 4);
  assert.equal(calls(plan), 1);
});

test('distinct image identities, coordinate frames and addressing modes retain their own reads', () => {
  const pixels = source(), otherPixels = image.data(pixels.resource);
  const frame = domain.transform(identity), otherFrame = domain.transform(identity);
  const variants = [
    [color.image(pixels), scalar.image(otherPixels)],
    [color.image(pixels), scalar.image(pixels, {domain: frame})],
    [color.image(pixels, {domain: frame}), scalar.image(pixels, {domain: otherFrame})],
    [color.image(pixels, {address: 'clamp'}), scalar.image(pixels, {address: 'repeat'})],
  ];
  for (const [pigment, height] of variants) {
    const plan = compileGraph(surface.bump(surface.material(pigment), height));
    assert.equal(plan.cost.textureReads, 8);
    assert.equal(calls(plan), 2);
  }
});

test('live frame, pixel and zero-amplitude edits preserve sample identity and demanded derivatives', () => {
  const pixels = named('pixels', source()), frame = named('frame', domain.transform(identity));
  const value = scalar.image(pixels, {domain: frame, channel: 'g'});
  const height = scalar.multiply(named('amount', scalar.parameter(0)), value);
  const graph = materialGraph(surface.bump(surface.material(color.image(pixels, {domain: frame})), height));
  const before = compileGraph(graph), shader = generateSurfaceShader(before);
  assert.equal(before.cost.textureReads, 4);
  assert.equal(calls(before), 1);
  assert.equal(before.nodes.filter(node => node.kind === 'bump').length, 1);
  const matrix = [...identity]; matrix[12] = .125;
  const after = compileGraph(patchGraph(graph, {
    amount: {value: .5}, frame: {matrix},
    pixels: {resource: {width: 1, height: 1, channels: 3, data: [.2, .4, .6]}},
  }));
  assert.equal(after.structure, before.structure);
  assert.equal(after.programKey, before.programKey);
  assert.deepEqual(generateSurfaceShader(after), shader);
  assert.equal(after.cost.textureReads, 4);
  const heightSample = createFieldSampler(height)(context);
  assert.deepEqual(heightSample, {value: 0, dx: 0, dy: 0});
  assert(createFieldSampler(value)(context).dx > 0);
});

test('literal zero removes only dead image paths and leaves surviving color reconstruction intact', () => {
  const pixels = source(), plain = surface.material(color.srgb('#243546'));
  const absent = scalar.multiply(0, scalar.image(pixels));
  const empty = compileGraph(surface.bump(plain, absent));
  assert.equal(empty.cost.textureReads, 0);
  assert.equal(calls(empty), 0);
  assert.deepEqual(generateSurfaceShader(empty), generateSurfaceShader(compileGraph(plain)));
  const colored = compileGraph(surface.bump(surface.material(color.image(pixels)), absent));
  assert.equal(colored.cost.textureReads, 4);
  assert.equal(calls(colored), 1);
  assert.equal(colored.nodes.some(node => node.kind === 'imageScalar'), false);
});

function observedResource() {
  const original = source().resource;
  let reads = 0;
  const data = new Proxy(original.data, {get(target, property, receiver) {
    if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
    return Reflect.get(target, property, receiver);
  }});
  return {resource: {...original, data}, reads: () => reads};
}

function reader(resource, kind, options = {}) {
  return fieldAlgebra[kind]({id: kind, kind, image: resource, address: 'clamp', channel: 'r', ...options});
}

test('CPU typed readers reconstruct once per sample and never reuse a previous context value', () => {
  const observed = observedResource();
  const point = fieldAlgebra.colorMix({id: 'mix', kind: 'colorMix',
    a: reader(observed.resource, 'imageColor'),
    b: fieldAlgebra.color({id: 'constant', kind: 'color', value: [.2, .4, .6]}),
    mask: reader(observed.resource, 'imageScalar')});
  const first = sampleField(point, context);
  assert.equal(observed.reads(), 12); // Four texels × three numeric components.
  const second = sampleField(point, {...context, position: [.625, .375, 0]});
  assert.equal(observed.reads(), 24);
  assert.notDeepEqual(second.value, first.value);
  assert.deepEqual(sampleField(point, context), first);
  assert.equal(observed.reads(), 36);
});

test('CPU sharing respects address and prepared-frame identity', () => {
  for (const variant of ['address', 'frame']) {
    const observed = observedResource();
    const options = variant === 'address' ? {address: 'repeat'} : {domain: state => state.base};
    const point = fieldAlgebra.colorMix({id: 'mix', kind: 'colorMix',
      a: reader(observed.resource, 'imageColor'),
      b: fieldAlgebra.color({id: 'constant', kind: 'color', value: [.2, .4, .6]}),
      mask: reader(observed.resource, 'imageScalar', options)});
    sampleField(point, context);
    assert.equal(observed.reads(), 24);
  }
});

test('shared CPU reconstruction validates only the channels a typed reader requests', () => {
  const resource = normalizeImage({width: 2, height: 1, channels: 3,
    data: [.25, 0, 3e38, .5, 0, -3e38]});
  const sample = {position: [.5, .5, 0], dx: [1, 0, 0]};
  assert.deepEqual(sampleField(reader(resource, 'imageScalar'), sample), {value: .375, dx: .5, dy: 0});
  assert.throws(() => sampleField(reader(resource, 'imageColor'), sample), /evaluated color/);
});

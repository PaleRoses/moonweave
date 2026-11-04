import test from 'node:test';
import assert from 'node:assert/strict';
import {
  image, scalar, color, surface, domain, named, materialGraph, compileGraph, patchGraph,
} from '../src/core.mjs';
import {normalizeImage, imageChannelRange} from '../src/core/resources.mts';

const rgb = {
  width: 2, height: 2, channels: 3,
  data: [2, -10, 0, 4, -2, .125, 1, -3, .5, 3, -5, -.25],
};
const bounds = {r: [1, 4], g: [-10, -2], b: [-.25, .5]};
const matrix = offset => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, offset, 0, 0, 1];
const sum = values => values.length === 1 ? values[0]
  : scalar.add(sum(values.slice(0, values.length >> 1)), sum(values.slice(values.length >> 1)));

test('image summaries follow immutable resource ownership and stored channels', () => {
  const resource = normalizeImage(rgb);
  for (const channel of ['r', 'g', 'b']) {
    const range = imageChannelRange(resource, channel);
    assert.deepEqual(range, bounds[channel]);
    assert.equal(imageChannelRange(resource, channel), range);
    assert(Object.isFrozen(range));
  }
  assert.notEqual(imageChannelRange(normalizeImage(rgb), 'r'), imageChannelRange(resource, 'r'),
    'equal caller pixels do not merge separate resource identities');

  const monochrome = normalizeImage({width: 3, height: 1, channels: 1, data: [2, -5, .5]});
  const range = imageChannelRange(monochrome, 'r');
  assert.deepEqual(range, [-5, 2]);
  assert.equal(imageChannelRange(monochrome, 'g'), range);
  assert.equal(imageChannelRange(monochrome, 'b'), range);

  const raw = Object.freeze({width: 2, height: 1, channels: 1, data: [1, 2]});
  assert.deepEqual(imageChannelRange(raw, 'r'), [1, 2]);
  raw.data[0] = -3;
  assert.deepEqual(imageChannelRange(raw, 'r'), [-3, 2],
    'frozen caller records still cross the snapshot boundary');
  assert.throws(() => imageChannelRange({...raw, data: [NaN, 2]}, 'r'), /finite float32/);
});

test('shared image bounds preserve every channel, filter, mapping and zero extension', () => {
  const pixels = named('pixels', image.data(rgb));
  const readers = [], expected = new Map();
  for (const channel of ['r', 'g', 'b']) for (const address of ['clamp', 'repeat', 'zero']) {
    for (const filter of ['linear', 'trilinear', 'anisotropic']) {
      const id = `${channel}_${address}_${filter}`;
      readers.push(named(id, scalar.image(pixels, {
        channel, address, filter, domain: domain.transform(matrix(readers.length / 10)),
      })));
      const [low, high] = bounds[channel];
      expected.set(id, address === 'zero' ? [Math.min(0, low), Math.max(0, high)] : [low, high]);
    }
  }
  const graph = materialGraph(surface.channels(surface.material(color.linear([.2, .3, .4])), {
    roughness: sum(readers),
  }));
  const first = compileGraph(graph);
  for (const [source, range] of expected) {
    assert.deepEqual(first.ranges[first.structure.sourceNodes[source]], range, source);
  }
  assert.deepEqual(first.opacityRange, [1, 1]);

  // A new topology may borrow the same normalized nodes/resources. Its range
  // analysis must be complete even though the image summary already exists.
  const second = compileGraph(materialGraph({...graph, nodes: [...graph.nodes]}));
  assert.notEqual(first.structure, second.structure);
  assert.equal(first.programKey, second.programKey);
  assert.deepEqual(first.ranges, second.ranges);
});

test('replacing one image alias revises its ranges without changing another borrower', () => {
  const resource = normalizeImage({width: 2, height: 1, channels: 1, data: [.25, .75]});
  const first = named('first', scalar.image(named('one', image.data(resource))));
  const second = named('second', scalar.image(named('two', image.data(resource))));
  const graph = materialGraph(surface.channels(surface.material(color.linear([.2, .3, .4])), {
    roughness: first, metalness: second,
  }));
  const before = compileGraph(graph);
  const firstId = before.structure.sourceNodes.first, secondId = before.structure.sourceNodes.second;
  const changed = patchGraph(graph, {one: {resource: {width: 2, height: 1, channels: 1, data: [-3, 2]}}});
  const after = compileGraph(changed);
  assert.equal(after.structure, before.structure);
  assert.deepEqual(after.ranges[firstId], [-3, 2]);
  assert.deepEqual(after.ranges[secondId], [.25, .75]);
  assert.equal(after.ranges[secondId], before.ranges[secondId]);
  assert.deepEqual(before.ranges[firstId], [.25, .75]);
  assert.equal(compileGraph(graph), before);

  const restored = compileGraph(patchGraph(changed, {one: {resource}}));
  assert.equal(restored.ranges[firstId], before.ranges[firstId]);
  assert.deepEqual(restored.ranges, before.ranges);
});

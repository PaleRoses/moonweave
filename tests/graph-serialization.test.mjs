import test from 'node:test';
import assert from 'node:assert/strict';
import {
  color, domain, expressionGraph, graphExpression, image, named, parseExpressionGraph,
  parseGraph, serializeGraph, surface,
} from '../src/core.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('graph JSON keeps vectors inline and structural objects readable without changing data', () => {
  const frame = named('rest', domain.transform(identity));
  const pixels = image.data({width: 2, height: 1, channels: 3, data: [0, .25, .5, .75, 1, -.25]});
  const graph = expressionGraph(surface.material(color.image(pixels, {domain: frame})));
  const text = serializeGraph(graph);
  assert(text.endsWith('\n'));
  assert.match(text, /"matrix": \[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1\]/);
  assert.match(text, /"data": \[0, 0\.25, 0\.5, 0\.75, 1, -0\.25\]/);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(graph)));
  assert.deepEqual(parseGraph(text), graph);
  assert.equal(serializeGraph(parseGraph(text)), text);
  assert.equal(serializeGraph(graphExpression(graph)), text);
});

test('large embedded image JSON has bounded rows and lossless canonical round trips', () => {
  const pixels = named('pixels', image.generate({width: 256, height: 256, channels: 3}, (_u, _v, x, y) =>
    [Math.sin(x * .13 + y * .07), (x - y) / 256, 3.4028234663852886e38]));
  const graph = expressionGraph(pixels), text = serializeGraph(graph), lines = text.split('\n');
  assert.equal(graph.nodes[0].resource.data.length, 196608);
  assert(lines.length < 3200, `resource should use numeric rows, received ${lines.length} lines`);
  assert(Math.max(...lines.map(line => line.length)) < 2048, 'numeric rows must stay bounded even at float32 limits');
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(graph)));
  assert.deepEqual(parseExpressionGraph(text), graph);
  assert.equal(serializeGraph(parseExpressionGraph(text)), text);
});

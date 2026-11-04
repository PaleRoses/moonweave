import test from 'node:test';
import assert from 'node:assert/strict';
import {color, scalar, surface, named, materialGraph, evaluateColor} from '../src/core.mjs';

test('compact smoothstep ramps equal expanded mixtures of varying color fields and their full differentials', () => {
  const input = named('coordinate', scalar.axis('x'));
  const noise = scalar.noise({seed: 31});
  const colors = [
    color.mix(color.linear([.1, .3, .7]), color.linear([.6, .2, .4]), scalar.ramp(scalar.axis('y'), -2, 2)),
    color.mix(color.linear([.3, .8, .1]), color.linear([.9, .1, .6]), noise),
    color.mix(color.linear([-.1, .4, .7]), color.linear([.5, .2, 1.2]), scalar.ramp(scalar.axis('z'), -1, 1)),
    color.mix(color.linear([.8, .6, .1]), color.linear([.3, .7, .9]), scalar.complement(noise)),
  ].map((expression, i) => named(`stop${i}`, expression));
  const positions = [-1, -.3, .4, 1.2];
  for (const space of ['linear-rgb', 'oklab']) {
    const compact = color.ramp(input, colors.map((value, i) => [positions[i], value]), {space, interpolation: 'smoothstep'});
    const expanded = colors.slice(1).reduce((previous, next, i) =>
      color.mix(previous, next, scalar.ramp(input, positions[i], positions[i + 1]), {space}), colors[0]);
    const graphs = [compact, expanded].map(expression => materialGraph(surface.material(named('palette', expression))));
    for (const x of [-2, ...positions, -.7, 0, .8, 2]) {
      const context = {position: [x, .21, -.37], dx: [.3, -.2, .4], dy: [-.1, .7, .2]};
      const [a, b] = graphs.map(graph => evaluateColor(graph, 'palette', context));
      for (const field of ['value', 'dx', 'dy']) a[field].forEach((value, i) =>
        assert.ok(Math.abs(value - b[field][i]) < 1e-12, `${space} ${field}[${i}] differs at x=${x}`));
    }
  }
});

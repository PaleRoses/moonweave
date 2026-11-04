import {evidencePath} from './evidence-path.mjs';
/** Compare actual representations and shader output; no frame-time claim. */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {color, scalar, surface, named, materialGraph, compileGraph, patchGraph, evaluateColor, serializeGraph} from '../src/core.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const hexes = [
  '#142f43', '#204857', '#2e6366', '#428075', '#649584', '#8eaa92', '#b7bca0', '#d5c6a8',
  '#e3c5a8', '#d7a58e', '#b9807d', '#8e6077', '#675274', '#465472', '#2d4961', '#172b42',
];
const input = named('position', scalar.parameter(0));
const colors = hexes.map((hex, i) => named(`stop${i}`, color.srgb(hex)));
const positions = colors.map((_, i) => i / (colors.length - 1));
const probes = [-.1, 1.1, ...positions, ...positions.slice(1).flatMap((high, i) =>
  [.25, .5, .75].map(weight => positions[i] + weight * (high - positions[i])))];

function graphs(space) {
  const compact = color.ramp(input, colors.map((value, i) => [positions[i], value]), {space, interpolation: 'smoothstep'});
  const expanded = colors.slice(1).reduce((previous, next, i) =>
    color.mix(previous, next, scalar.ramp(input, positions[i], positions[i + 1]), {space}), colors[0]);
  return [compact, expanded].map(expression => materialGraph(surface.material(named('palette', expression))));
}

function size(graph) {
  const plan = compileGraph(graph), shader = generateSurfaceShader(plan);
  return {
    authoredNodes: graph.nodes.length, liveNodes: plan.nodes.length,
    uniformScalars: plan.cost.uniformScalars,
    serializedJSONBytes: Buffer.byteLength(serializeGraph(graph)),
    generatedGLSLBytes: Buffer.byteLength(shader.declarations + shader.evaluate),
  };
}

const comparisons = Object.fromEntries(['linear-rgb', 'oklab'].map(space => {
  const [compact, expanded] = graphs(space);
  const keys = [compact, expanded].map(graph => compileGraph(graph).programKey);
  let maxAbsoluteValueError = 0, maxAbsoluteDerivativeError = 0;
  // Exercise every knot and three interiors of every interval before and after
  // an independent stop edit. Both the palette and the input remain uniforms.
  for (const changed of [false, true]) for (const value of probes) {
    const edits = {position: {value}, ...(changed ? {stop7: {value: [.2, .4, .6]}} : {})};
    const graphs = [compact, expanded].map((graph, i) => {
      const next = patchGraph(graph, edits);
      assert.equal(compileGraph(next).programKey, keys[i]);
      return next;
    });
    const [a, b] = graphs.map(graph => evaluateColor(graph, 'palette'));
    for (const field of ['value', 'dx', 'dy']) for (let channel = 0; channel < 3; channel++) {
      const error = Math.abs(a[field][channel] - b[field][channel]);
      assert.ok(error < 1e-12, `${space} ${field}[${channel}] differs by ${error} at ${value}`);
      if (field === 'value') maxAbsoluteValueError = Math.max(maxAbsoluteValueError, error);
      else maxAbsoluteDerivativeError = Math.max(maxAbsoluteDerivativeError, error);
    }
  }
  return [space, {
    compact: size(compact), expanded: size(expanded),
    comparisons: probes.length * 2,
    maxAbsoluteValueError, maxAbsoluteDerivativeError,
    valueEditsPreserveProgram: true,
  }];
}));

const report = {
  version: JSON.parse(readFileSync(resolve(root, 'package.json'))).version,
  method: 'Compare a 16-stop smoothstep color ramp with the equivalent nested color.mix/scalar.ramp chain, using the same named editable colors and input. Count compiled nodes, uniform components, serialized graph bytes and actual generated GLSL bytes. Compare CPU colors at endpoints, knots and interval interiors, before and after a color edit. Input is a parameter, so these receipt derivatives are zero; varying-stop/full-differential equivalence is separately tested. No CPU or GPU timing claim.',
  comparisons,
};
writeFileSync(resolve(process.argv[2] ?? evidencePath('color.json')), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

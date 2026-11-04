/** Point probes for the complete generated program, compared with its CPU fold. */
import assert from 'node:assert/strict';
import {
  color, scalar, surface, named, materialGraph, patchGraph, compileGraph, evaluateColor,
} from '../src/core.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {graphUniformValues} from '../src/three/uniforms.mts';

const points = [
  [0, 0, 0], [.25, .5, .75], [-.25, -.5, -.75], [.12345, .67891, -.2468],
  [2.875, -3.125, .0625], [-1 / 1024, .25, .5], [1 / 1024, .25, .5],
  [65535.75, 2.125, -65536.5], [65536, 65536, -65536],
  [65536.25, 65535.875, -65536.25], [65536 - 1 / 256, .25, .75],
  [65536 + 1 / 128, .25, .75], [2 ** 31, 1.125, -.625],
  [1e19, -1e19, .25], [-1e19, 1e19, -1e19], [.9999, -.9999, 3.1415927],
].map(point => point.map(Math.fround));
const seeds = [0, 1, 29031, 2 ** 31, 0xffffffff];
const palettes = [
  [[.123, .345, .678], [.782, .613, .241]],
  [[.031, .901, .117], [.927, .058, .823]],
];

function probeProgram(plan, id, label) {
  const generated = generateSurfaceShader(plan);
  const vertex = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 uProbePosition;
out vec3 vMoonweavePosition;
out vec3 vMoonweaveNormal;
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
  vMoonweavePosition = uProbePosition;
  vMoonweaveNormal = vec3(0.0, 1.0, 0.0);
}
`;
  const fragment = `#version 300 es
precision highp float;
precision highp int;
#define varying in
${generated.declarations}
${generated.evaluate}
uniform int uProbeChannel;
out vec4 probeResult;
void main() {
  MoonweaveSurface sampled = moonweaveGraph();
  uint bits = floatBitsToUint(sampled.color[uProbeChannel]);
  uvec4 bytes = (uvec4(bits) >> uvec4(0u, 8u, 16u, 24u)) & uvec4(255u);
  probeResult = vec4(bytes) / 255.0;
}
`;
  return {id, engine: 'core', coordinates: 'point', label, vertex, fragment};
}

export function proceduralProbes() {
  const noise = named('probeNoise', scalar.noise());
  const mask = named('probeRamp', scalar.ramp(noise, .25, .75));
  const pigment = named('probeColor', color.mix(
    named('probeA', color.linear(palettes[0][0])),
    named('probeB', color.linear(palettes[0][1])), mask,
  ));
  const graph = materialGraph(surface.channels(surface.material(pigment), {roughness: noise}));
  const plan = compileGraph(graph);
  assert.equal(plan.nodes.filter(node => node.kind === 'noise').length, 1);
  assert.equal(plan.cost.textureReads, 0);

  const cases = [];
  function add(label, position, seed, palette, low = .25, high = .75) {
    const edited = patchGraph(graph, {
      probeNoise: {seed}, probeA: {value: palette[0]}, probeB: {value: palette[1]},
      probeRamp: {low, high},
    });
    const updated = compileGraph(edited);
    assert.equal(updated.structure, plan.structure);
    assert.equal(updated.programKey, plan.programKey);
    cases.push({label,
      uniforms: {uProbePosition: position,
        ...Object.fromEntries(graphUniformValues(updated).map(binding => [binding.name, binding.value]))},
      expected: evaluateColor(edited, 'probeColor', {position}).value,
    });
  }
  for (const [seedIndex, seed] of seeds.entries()) for (const [pointIndex, position] of points.entries()) {
    add(`seed-${seed}/point-${pointIndex}`, position, seed, palettes[(seedIndex + pointIndex) % palettes.length]);
  }
  for (const [pointIndex, position] of points.slice(0, 3).entries()) {
    add(`clamped-low/${pointIndex}`, position, 0xffffffff, palettes[0], 1, 2);
    add(`clamped-high/${pointIndex}`, position, 0, palettes[1], -1, 0);
  }
  return {
    program: probeProgram(plan, 'procedural-probe', 'procedural-color'),
    cases, tolerance: 2e-6,
  };
}

/** Exercise generated piecewise color programs, including live knot updates. */
export function colorProbes() {
  const groups = [];
  const positions = [-1, -.25, .5, 1.25];
  const colors = [[-.125, .03125, .25], [.75, .125, .0625], [.0625, .625, .25], [1.25, .75, .125]];
  const clamp = value => Math.max(0, Math.min(1, value));
  function probeCase(graph, label, position, expectedNode = 'probeColor') {
    const plan = compileGraph(graph);
    return {label, uniforms: {uProbePosition: position,
      ...Object.fromEntries(graphUniformValues(plan).map(binding => [binding.name, binding.value]))},
      expected: evaluateColor(graph, expectedNode, {position}).value.map(clamp)};
  }
  for (const space of ['linear-rgb', 'oklab']) {
    for (const interpolation of ['linear', 'smoothstep', 'constant']) {
      const stops = colors.map((value, index) => [positions[index], named(`stop${index}`, color.linear(value))]);
      // One stop is itself a color field; selecting a ramp interval does not
      // imply that its colors are constants or that its input is normalized.
      stops[1][1] = color.mix(stops[1][1], color.linear([.125, .0625, .75]),
        named('variation', scalar.noise({seed: 37})), {space});
      const graph = materialGraph(surface.material(named('probeColor', color.ramp(scalar.axis('x'), stops, {space, interpolation}))));
      const plan = compileGraph(graph), id = `color-ramp-${space}-${interpolation}`;
      const cases = [];
      const samplePositions = [-2, ...positions.flatMap(value => [value - 1 / 1024, value, value + 1 / 1024]), -.625, .125, .875, 2];
      for (const [index, x] of samplePositions.entries()) cases.push(probeCase(graph, `base-${index}`, [x, .125, -.375]));
      const editedPositions = [-2, -.5, .25, 2];
      const edited = patchGraph(graph, {probeColor: {positions: editedPositions}, stop2: {value: [-.25, 1.5, .375]}, variation: {seed: 0xffffffff}});
      assert.equal(compileGraph(edited).structure, plan.structure);
      assert.equal(compileGraph(edited).programKey, plan.programKey);
      for (const [index, x] of [...editedPositions, -1.25, -.125, 1.125].entries()) {
        cases.push(probeCase(edited, `edited-${index}`, [x, -.25, .375]));
      }
      groups.push({program: probeProgram(plan, id, id), cases, tolerance: space === 'oklab' ? 5e-6 : 2e-6});
    }
    const weight = named('weight', scalar.parameter(.5));
    const graph = materialGraph(surface.material(named('probeColor', color.mix(
      named('first', color.linear([0, 0, 0])), named('second', color.linear([1, 1, 1])), weight, {space},
    ))));
    const plan = compileGraph(graph), cases = [], id = `color-mix-${space}`;
    for (const [index, palette] of [
      [[0, 0, 0], [1, 1, 1]], [[1, 0, 0], [0, 0, 1]],
      [[-.25, .125, 1.5], [.75, 1.25, -.125]],
      [[1, 1, 1], [1e-20, 1e-25, 1e-30]],
    ].entries()) for (const value of [-1, 0, .25, .5, .75, 1, 2]) {
      const edited = patchGraph(graph, {first: {value: palette[0]}, second: {value: palette[1]}, weight: {value}});
      assert.equal(compileGraph(edited).programKey, plan.programKey);
      cases.push(probeCase(edited, `palette-${index}/weight-${value}`, [.25, .5, .75]));
    }
    groups.push({program: probeProgram(plan, id, id), cases, tolerance: space === 'oklab' ? 5e-6 : 2e-6});
  }
  // Exercise all sixteen live stop uniforms and the last interval, not just
  // short convenience ramps. Stop colors remain independently editable.
  const stops = Array.from({length: 16}, (_, index) => [index - 8,
    named(`stop${index}`, color.linear([index / 16, (15 - index) / 16, (index % 3) / 2]))]);
  const graph = materialGraph(surface.material(named('probeColor', color.ramp(scalar.axis('x'), stops, {space: 'oklab', interpolation: 'smoothstep'}))));
  const id = 'color-ramp-sixteen', plan = compileGraph(graph);
  const cases = Array.from({length: 33}, (_, index) => {
    const x = index / 2 - 8.5;
    return probeCase(graph, `interval-${index}`, [x, .25, .5]);
  });
  groups.push({program: probeProgram(plan, id, id), cases, tolerance: 5e-6});
  // Adjacent shared references are an identity even when other ramp stops
  // differ. Dyadic color coordinates make this a strict float identity probe.
  const shared = color.linear([.125, .25, .75]);
  const sharedGraph = materialGraph(surface.material(named('probeColor', color.ramp(scalar.axis('x'), [
    [0, color.linear([.75, .125, .25])], [1, shared], [2, shared], [3, color.linear([.25, .75, .125])],
  ], {space: 'oklab'}))));
  const sharedId = 'color-ramp-shared-interval';
  groups.push({program: probeProgram(compileGraph(sharedGraph), sharedId, sharedId),
    cases: [1, 1.25, 1.5, 1.75, 2].map(value => probeCase(sharedGraph, `shared-${value}`, [value, 0, 0])), tolerance: 0});
  // Perceptual adjustments retain live controls, extended input coordinates,
  // periodic hue and spatial control fields. Probe the actual material boundary.
  const adjusted = materialGraph(surface.material(named('probeColor', color.adjust(
    named('pigment', color.linear([.125, .25, .625])), {
      lightness: named('lightness', scalar.parameter(0)),
      chroma: named('chroma', scalar.parameter(1)),
      hue: named('hue', scalar.parameter(0)),
    },
  ))));
  const adjustPlan = compileGraph(adjusted), adjustCases = [];
  for (const [index, value] of [
    [.125, .25, .625], [0, 0, 0], [.25, .25, .25], [-.125, .375, 1.5], [1, .015625, .0625],
  ].entries()) for (const [edit, controls] of [
    [0, 1, 0], [.125, .75, 35], [-.125, 1.25, -180], [.0625, -.75, 540], [0, 0, 360], [0, 1, 720],
  ].entries()) {
    const updated = patchGraph(adjusted, {pigment: {value}, lightness: {value: controls[0]},
      chroma: {value: controls[1]}, hue: {value: controls[2]}});
    assert.equal(compileGraph(updated).programKey, adjustPlan.programKey);
    adjustCases.push(probeCase(updated, `pigment-${index}/adjustment-${edit}`, [.25, .5, .75]));
  }
  groups.push({program: probeProgram(adjustPlan, 'color-adjust-live', 'color-adjust-live'),
    cases: adjustCases, tolerance: 5e-6});
  const axis = scalar.axis('x'), variation = scalar.noise({seed: 37});
  const spatial = materialGraph(surface.material(named('probeColor', color.adjust(
    color.mix(color.linear([.125, .25, .625]), color.linear([.75, .125, .0625]), variation, {space: 'oklab'}), {
      lightness: scalar.multiply(.125, axis), chroma: scalar.add(.75, scalar.multiply(.25, variation)),
      hue: scalar.multiply(180, axis),
    },
  ))));
  groups.push({program: probeProgram(compileGraph(spatial), 'color-adjust-spatial', 'color-adjust-spatial'),
    cases: [-3, -1, -.5, 0, .5, 1, 3].map((x, index) => probeCase(spatial, `position-${index}`, [x, .25, -.375])),
    tolerance: 5e-6});
  return groups;
}

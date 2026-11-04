/** Analytic height differentials from the generated program, transported as float bits. */
import assert from 'node:assert/strict';
import {
  color, scalar, mask, surface, domain, named, materialGraph, patchGraph,
  compileGraph, evaluateScalar,
} from '../src/core.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {graphUniformValues} from '../src/three/uniforms.mts';

const contexts = [
  {position: [.125, -.25, .375], normal: [0, 1, 0], dx: [.03125, 0, .015625], dy: [0, .0625, -.03125]},
  {position: [-.375, .3125, -.625], normal: [.25, .875, -.125], dx: [-.0625, .03125, .015625], dy: [.015625, -.03125, .0625], normalDx: [.015625, -.03125, .0625], normalDy: [-.03125, .015625, .03125]},
  {position: [1.25, -1.5, 2.375], normal: [-.375, .5, .75], dx: [.125, .015625, -.0625], dy: [-.03125, .0625, .015625], normalDx: [.0625, .03125, -.015625], normalDy: [.015625, -.0625, .03125]},
  {position: [0, 0, 0], normal: [0, 0, 1], dx: [.03125, 0, 0], dy: [0, .03125, 0]},
  {position: [.9990234375, -.0009765625, -.5], normal: [0, 1, 0], dx: [.0001220703125, 0, 0], dy: [0, .000244140625, 0]},
  {position: [65535.75, .125, -65535.5], normal: [0, 1, 0], dx: [.0625, 0, .125], dy: [0, .0625, 0]},
];
const frame = () => domain.transform([
  1.5, .25, 0, 0, -.125, .75, .25, 0, .25, 0, 1.25, 0, .125, -.25, .375, 1,
]);

function probeProgram(plan, id) {
  const generated = generateSurfaceShader(plan);
  return {
    id, engine: 'core', coordinates: 'differential-plane', label: id,
    vertex: `#version 300 es
precision highp float;
precision highp int;
uniform vec3 uProbePosition, uProbeDx, uProbeDy;
uniform vec3 uProbeNormal, uProbeNormalDx, uProbeNormalDy;
out vec3 vMoonweavePosition;
out vec3 vMoonweaveNormal;
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
  // At the center of the one-pixel viewport the input is exactly the probe
  // point. The neighboring fragment lanes supply its declared screen tangents.
  vec2 delta = corner - 0.5;
  vMoonweavePosition = uProbePosition + delta.x * uProbeDx + delta.y * uProbeDy;
  vMoonweaveNormal = uProbeNormal + delta.x * uProbeNormalDx + delta.y * uProbeNormalDy;
}
`,
    fragment: `#version 300 es
precision highp float;
precision highp int;
#define varying in
${generated.declarations}
${generated.evaluate}
uniform int uProbeChannel;
out vec4 probeResult;
void main() {
  MoonweaveSurface sampled = moonweaveGraph();
  vec3 result = vec3(sampled.slope, 0.0);
  uint bits = floatBitsToUint(result[uProbeChannel]);
  uvec4 bytes = (uvec4(bits) >> uvec4(0u, 8u, 16u, 24u)) & uvec4(255u);
  probeResult = vec4(bytes) / 255.0;
}
`,
  };
}

export function differentialProbes() {
  const groups = [];
  function group(name, build, options = {}) {
    const {heights, shared, patches = [{}]} = build();
    let base = surface.material(color.linear([.5, .5, .5]));
    if (shared) base = surface.channels(base, {roughness: shared});
    const names = heights.map((_, index) => `height${index}`);
    const graph = materialGraph(heights.reduce((input, height, index) =>
      surface.bump(input, named(names[index], height)), base));
    const plan = compileGraph(graph), id = `height-${name}`, cases = [];
    for (const [editIndex, edits] of patches.entries()) {
      const updated = patchGraph(graph, edits), next = compileGraph(updated);
      assert.equal(next.structure, plan.structure);
      assert.equal(next.programKey, plan.programKey);
      for (const [index, context] of (options.contexts ?? contexts.slice(0, 5)).entries()) {
        const samples = names.map(name => evaluateScalar(updated, name, context));
        cases.push({label: `edit-${editIndex}/context-${index}`, uniforms: {
          ...Object.fromEntries(graphUniformValues(next).map(binding => [binding.name, binding.value])),
          uProbePosition: context.position, uProbeDx: context.dx, uProbeDy: context.dy,
          uProbeNormal: context.normal, uProbeNormalDx: context.normalDx ?? [0, 0, 0],
          uProbeNormalDy: context.normalDy ?? [0, 0, 0],
        }, expected: [samples.reduce((sum, sample) => sum + sample.dx, 0),
          samples.reduce((sum, sample) => sum + sample.dy, 0), 0]});
      }
    }
    groups.push({program: probeProgram(plan, id), cases, tolerance: options.tolerance ?? 8e-6});
  }
  group('axis', () => ({heights: [scalar.axis('x')]}), {contexts});
  group('transformed-axis', () => ({heights: [scalar.axis('y', frame())]}));
  group('product-and-ramp', () => {
    const amplitude = named('amount', scalar.parameter(.25));
    const threshold = named('threshold', scalar.ramp(scalar.axis('y'), -.5, .75));
    return {heights: [scalar.multiply(scalar.multiply(amplitude, scalar.add(.125, scalar.axis('x'))), scalar.complement(threshold))],
      patches: [{}, {amount: {value: 0}}, {amount: {value: -.5}, threshold: {low: -.25, high: 1}}]};
  });
  group('noise-shared', () => {
    const noise = named('grain', scalar.noise({seed: 37}));
    return {shared: noise, heights: [scalar.multiply(.25, noise)],
      patches: [{}, {grain: {seed: 0}}, {grain: {seed: 0xffffffff}}]};
  }, {contexts});
  group('transformed-noise', () => {
    const noise = named('grain', scalar.noise({seed: 29, domain: frame()}));
    return {heights: [scalar.multiply(-.125, scalar.ramp(noise, .2, .8))],
      patches: [{}, {grain: {seed: 7}}]};
  });
  group('facing', () => ({heights: [scalar.facing([.25, 1, -.5])]}));
  group('transformed-facing', () => ({heights: [scalar.facing([-.5, .25, 1], frame(), true)]}));
  group('layered-heights', () => {
    const x = scalar.axis('x'), mask = scalar.ramp(scalar.axis('y'), -.25, .75);
    return {heights: [scalar.multiply(.125, x), scalar.multiply(mask, scalar.multiply(x, x))]};
  });
  group('uniform', () => ({heights: [scalar.add(named('offset', scalar.parameter(.5)), 2)],
    patches: [{}, {offset: {value: -2}}]}), {tolerance: 0});
  const maskContexts = [-1.125, -1, -.875, -.75, 0, .75, .875, 1, 1.125].map(x => ({
    position: [x, -.875, .875], normal: [0, 0, 1], dx: [.03125, .015625, 0], dy: [0, -.03125, .0625],
  }));
  group('chisel-mask', () => ({heights: [mask.chisel({feather: [.25, .5, .5]})]}), {contexts: maskContexts});
  group('placed-chisel', () => ({heights: [mask.chisel({domain: frame(), feather: [.5, .75, .25]})]}));
  return groups;
}

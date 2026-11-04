/** Native image-field probes. The generated program's raw values survive unclamped. */
import assert from 'node:assert/strict';
import {
  image, color, scalar, surface, domain, named, materialGraph, patchGraph,
  compileGraph, evaluateScalar, evaluateColor,
} from '../src/core.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {graphUniformValues} from '../src/three/uniforms.mts';
import {imageTextureLevels} from '../src/three/images.mts';

export const encodeImageLevels = levels => levels.map(({width, height, data}) => ({width, height,
  data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')}));

/** Match the renderer's explicit RGBA32F representation, with no color conversion. */
export function resourceProbeBindings(plan) {
  const uniforms = {}, resources = [];
  for (const binding of graphUniformValues(plan)) {
    if (binding.type !== 'sampler2D') uniforms[binding.name] = binding.value;
    else {
      uniforms[binding.name] = 3 + resources.length;
      resources.push({uniform: binding.name, levels: encodeImageLevels(imageTextureLevels(binding.value))});
    }
  }
  return {uniforms, resources};
}

const contexts = [
  [.125, .25, 0], [.375, .75, 0], [.875, .75, 0], [.21875, .4375, .125],
  [0, 0, 0], [1, 1, 0], [-.125, -.25, .25], [1.125, 1.25, -.25],
  [-3, 2.25, 0], [1 / 2048, 1 - 1 / 1024, 0],
].map(position => ({position, normal: [0, 0, 1],
  dx: [.03125, .015625, .0078125], dy: [-.015625, .03125, .015625]}));

const transformed = () => domain.transform([
  .75, .25, 0, 0, -.125, 1.25, 0, 0, 0, .125, 1, 0, .125, -.25, 0, 1,
], domain.transform([
  1.5, -.25, 0, 0, .25, .75, 0, 0, -.125, .25, 1, 0, .125, .125, 0, 1,
]));

const filteredContexts = [
  ['zero-footprint', [.21875, .4375, 0], [0, 0, 0], [0, 0, 0]],
  ['magnification', [.21875, .4375, 0], [.0078125, 0, 0], [0, .0078125, 0]],
  ['mip-below', [.21875, .4375, 0], [.109375, 0, 0], [0, .21875, 0]],
  ['mip-above', [.21875, .4375, 0], [.125, 0, 0], [0, .25, 0]],
  ['anisotropic', [.375, .625, 0], [.5, 0, 0], [0, .25, 0]],
  ['rotated', [.21875, .4375, 0], [.1875, .375, 0], [-.125, .0625, 0]],
  ['sheared', [.21875, .4375, 0], [.5, .125, 0], [.375, .1875, 0]],
  ['rank-one', [.21875, .4375, 0], [.5, .25, 0], [.25, .125, 0]],
  ['anisotropy-cap', [.375, .625, 0], [2, .125, 0], [.015625, .03125, 0]],
  ['left-fringe', [-.25, .4375, 0], [.25, 0, 0], [0, .25, 0]],
  ['right-fringe', [1.25, .4375, 0], [.25, 0, 0], [0, .25, 0]],
  ['bottom-fringe', [.21875, -.25, 0], [.25, 0, 0], [0, .25, 0]],
  ['top-fringe', [.21875, 1.25, 0], [.25, 0, 0], [0, .25, 0]],
  ['repeat-seam', [-1.125, 2.375, 0], [.1875, .0625, 0], [0, .1875, 0]],
  ['virtual-levels', [.21875, .4375, 0], [16, 0, 0], [0, 16, 0]],
  ['far-exterior', [16, -16, 0], [.125, 0, 0], [0, .125, 0]],
].map(([label, position, dx, dy]) => ({label, position, normal: [0, 0, 1], dx, dy,
  footprint: {dx, dy}}));

function probeProgram(plan, id, kind) {
  const generated = generateSurfaceShader(plan);
  const output = plan.nodes.find(node => node.id === plan.output);
  assert.equal(output.kind, kind === 'scalar' ? 'bump' : 'material');
  const result = kind === 'scalar'
    ? `vec3(mw_${output.height}, mw_${output.id}.slope)` : `mw_${output.color}`;
  const anchor = `  return mw_${plan.output};`;
  assert(generated.evaluate.includes(anchor));
  // The only instrumentation observes already computed values immediately
  // before returning. Sampling, addressing and chain rules stay generated code.
  const evaluate = generated.evaluate.replace(anchor, `  mwProbeValue = ${result};\n${anchor}`);
  return {
    id, engine: 'core', coordinates: 'resource-plane', label: id,
    vertex: `#version 300 es
precision highp float;
precision highp int;
uniform vec3 uProbePosition, uProbeDx, uProbeDy;
out vec3 vMoonweavePosition;
out vec3 vMoonweaveNormal;
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
  vec2 delta = corner - 0.5;
  vMoonweavePosition = uProbePosition + delta.x * uProbeDx + delta.y * uProbeDy;
  vMoonweaveNormal = vec3(0.0, 0.0, 1.0);
}
`,
    fragment: `#version 300 es
precision highp float;
precision highp int;
#define varying in
#define texture2D texture
${generated.declarations}
vec3 mwProbeValue;
${evaluate}
uniform int uProbeChannel;
out vec4 probeResult;
void main() {
  MoonweaveSurface sampled = moonweaveGraph();
  uint bits = floatBitsToUint(mwProbeValue[uProbeChannel]);
  uvec4 bytes = (uvec4(bits) >> uvec4(0u, 8u, 16u, 24u)) & uvec4(255u);
  probeResult = vec4(bytes) / 255.0;
}
`,
  };
}

export function resourceProbes() {
  const groups = [];
  const gray = image.generate({width: 4, height: 2, channels: 1}, (u, v, x, y) =>
    x * x / 8 - y * .5 + u * v);
  const rgb = image.generate({width: 4, height: 2, channels: 3}, (u, v, x, y) =>
    [u + 2 * v - .5, u * v - .25, .5 - x / 4 + y / 8]);
  const replacement = image.generate({width: 3, height: 2, channels: 3}, (u, v) =>
    [1.5 * u - v, .125 + u * v, 1 - u - v]);
  const single = image.data({width: 1, height: 1, channels: 1, data: [-.3125]});

  function group(name, kind, resource, build, patches = [{}], sampleContexts = contexts) {
    const source = named('probeImage', resource);
    const field = named('probeField', build(source));
    const expression = kind === 'scalar'
      ? surface.bump(surface.material(color.image(source, {address: 'repeat'})), field)
      : surface.material(field);
    const graph = materialGraph(expression), plan = compileGraph(graph), id = `resource-${name}`;
    assert.equal(plan.nodes.filter(node => node.kind === 'image').length, 1);
    const cases = [];
    for (const [editIndex, patch] of patches.entries()) {
      const updated = patchGraph(graph, patch), next = compileGraph(updated);
      assert.equal(next.structure, plan.structure);
      assert.equal(next.programKey, plan.programKey);
      const bindings = resourceProbeBindings(next);
      assert.equal(bindings.resources.length, 1);
      for (const [index, context] of sampleContexts.entries()) {
        const sample = kind === 'scalar' ? evaluateScalar(updated, 'probeField', context)
          : evaluateColor(updated, 'probeField', context);
        cases.push({label: `edit-${editIndex}/${context.label ?? `context-${index}`}`,
          resources: bindings.resources,
          uniforms: {...bindings.uniforms, uProbePosition: context.position, uProbeDx: context.dx, uProbeDy: context.dy},
          expected: kind === 'scalar' ? [sample.value, sample.dx, sample.dy] : sample.value});
      }
    }
    groups.push({program: probeProgram(plan, id, kind), cases, tolerance: 3e-6,
      kind: kind === 'scalar' ? 'value-and-screen-differentials' : 'linear-rgb-value'});
  }
  const edits = [{}, {probeImage: {resource: replacement.resource}}, {probeImage: {resource: single.resource}}];
  for (const address of ['clamp', 'repeat']) {
    group(`scalar-${address}`, 'scalar', gray, source => scalar.image(source, {address}), edits);
    group(`color-${address}`, 'color', rgb, source => {
      const value = color.image(source, {address});
      // Consume both RGB and the green scalar projection of one reconstruction;
      // neither reader can be discarded without changing the probed result.
      return address === 'repeat' ? color.mix(value, color.linear([.125, .375, .625]),
        scalar.image(source, {address, channel: 'g'})) : value;
    }, edits);
    group(`transformed-${address}`, 'scalar', gray, source =>
      scalar.image(source, {address, domain: transformed()}));
  }
  for (const channel of ['g', 'b']) group(`channel-${channel}`, 'scalar', rgb, source =>
    scalar.image(source, {address: 'repeat', channel}));
  group('masked-height', 'scalar', gray, source => scalar.multiply(
    scalar.image(source, {address: 'repeat', domain: transformed()}),
    scalar.ramp(scalar.axis('y'), -.5, 1.5),
  ));

  const detail = image.generate({width: 17, height: 9, channels: 3}, (u, v, x, y) =>
    [.1 + .8 * ((x + y) % 2), (x + 2 * y) % 5 / 5, .125 + .5 * u * v]);
  const editedDetail = image.generate({width: 8, height: 3, channels: 3}, (u, v) =>
    [u * u, .2 + .3 * v, .75 - .5 * u * v]);
  const filteredEdits = [{}, {probeImage: {resource: editedDetail.resource}},
    {probeImage: {resource: single.resource}}];
  // Existing programs retain their point contract. New probes supply footprint
  // separately to the CPU, equal to screen dx/dy for this planar native setup.
  group('linear-zero', 'scalar', detail, source => scalar.image(source, {address: 'zero'}));
  for (const filter of ['trilinear', 'anisotropic']) for (const address of ['clamp', 'repeat', 'zero']) {
    group(`${filter}-${address}`, 'scalar', detail, source =>
      scalar.image(source, {filter, address, channel: 'g'}), filteredEdits, filteredContexts);
    group(`${filter}-${address}-color-sharing`, 'color', detail, source => {
      const value = color.image(source, {filter, address});
      return color.mix(value, color.linear([.125, .375, .625]),
        scalar.image(source, {filter, address, channel: 'g'}));
    }, [{}], filteredContexts);
  }
  for (const address of ['repeat', 'zero']) group(`anisotropic-transformed-${address}`, 'scalar', detail,
    source => scalar.image(source, {filter: 'anisotropic', address, domain: transformed()}),
    [{}], filteredContexts);
  group('filtered-masked-height', 'scalar', detail, source => scalar.multiply(
    scalar.image(source, {filter: 'anisotropic', address: 'zero', domain: transformed()}),
    scalar.ramp(scalar.axis('y'), -.5, 1.5),
  ), [{}], filteredContexts);
  const ribbon = image.generate({width: 16, height: 1, channels: 1}, (_u, _v, x) =>
    .125 + .75 * (x % 2));
  for (const address of ['clamp', 'zero']) group(`singleton-${address}`, 'scalar', ribbon,
    source => scalar.image(source, {filter: 'trilinear', address}), [{}], filteredContexts);

  const huge = domain.transform([1e18, 0, 0, 0, 0, 1e18, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const hugeContexts = [1, -1].map(sign => ({label: `sign-${sign}`, position: [sign * 1e20, 0, 0],
    normal: [0, 0, 1], dx: [0, 0, 0], dy: [0, 0, 0],
    footprint: {dx: [0, 0, 0], dy: [0, 0, 0]}}));
  group('huge-coordinate-zero', 'scalar', detail, source =>
    scalar.image(source, {filter: 'anisotropic', address: 'zero', domain: huge}), [{}], hugeContexts);
  const bright = image.data({width: 1, height: 1, channels: 1, data: [1e38]});
  const broadContext = {label: 'large-value-large-footprint', position: [.5, .5, 0], normal: [0, 0, 1],
    dx: [1e20, 0, 0], dy: [0, 1e20, 0], footprint: {dx: [1e20, 0, 0], dy: [0, 1e20, 0]}};
  group('virtual-level-dynamic-range', 'scalar', bright, source =>
    scalar.image(source, {filter: 'trilinear', address: 'zero'}), [{}], [broadContext]);
  return groups;
}

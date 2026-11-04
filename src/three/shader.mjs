import {PAINT_LAYOUT} from '../paint/data.mts';
import {FACETS_GLSL} from './facets.mjs';
import {COLOR_GLSL, COLOR_ADJUST_GLSL} from './color.mjs';
import {graphUniformValues} from './uniforms.mts';
import {createFieldShader, valueName, positionName, normalName} from './fields.mjs';

export const TEXTURING_SHADER_VERSION = `moonweave-graph/2:${PAINT_LAYOUT}`;
export const SURFACE_SHADER_LIMITS = Object.freeze({nodes: 256, fields: 8, paints: 16, proceduralFields: 16, images: 6});

const varyings = /* glsl */`
varying vec3 vMoonweavePosition;
varying vec3 vMoonweaveNormal;
`;

const kernel = /* glsl */`
struct MoonweaveSurface {
  vec3 color;
  vec2 slope;
  float roughness;
  float metalness;
  float clearcoat;
  float opacity;
};

vec3 mwNormalize(vec3 value) {
  float largest = max(max(abs(value.x), abs(value.y)), abs(value.z));
  vec3 scaled = value / max(largest, 1e-30);
  return scaled * inversesqrt(max(dot(scaled, scaled), 1e-30));
}

vec3 mwTransformNormal(mat3 frame, vec3 n) {
  // Scale actual column contributions before summing. Scaling the whole matrix
  // on the CPU would erase small axes in an anisotropic but valid domain.
  vec3 a = frame[0] * n.x, b = frame[1] * n.y, c = frame[2] * n.z;
  vec3 bound = max(max(abs(a), abs(b)), abs(c));
  float magnitude = max(max(max(bound.x, bound.y), bound.z), 1e-30);
  return mwNormalize(a / magnitude + b / magnitude + c / magnitude);
}

vec3 mwColorMixLinear(vec3 a, vec3 b, float weight) {
  if (weight <= 0.0) return a;
  if (weight >= 1.0) return b;
  return mix(a, b, weight);
}

MoonweaveSurface mwMix(MoonweaveSurface a, MoonweaveSurface b, float mask) {
  float weight = clamp(mask, 0.0, 1.0);
  MoonweaveSurface result;
  result.color = mix(a.color, b.color, weight);
  // An artistic gradient mixture, not the derivative of a mixed height field.
  result.slope = mix(a.slope, b.slope, weight);
  result.roughness = mix(a.roughness, b.roughness, weight);
  result.metalness = mix(a.metalness, b.metalness, weight);
  result.clearcoat = mix(a.clearcoat, b.clearcoat, weight);
  result.opacity = mix(a.opacity, b.opacity, weight);
  return result;
}

vec3 moonweaveNormal(vec3 baseNormal, vec3 dpdx, vec3 dpdy, vec2 slope, float facing) {
  vec3 r1 = cross(dpdy, baseNormal), r2 = cross(baseNormal, dpdx);
  float determinant = dot(dpdx, r1) * facing;
  float safeDeterminant = max(abs(determinant), max(length(dpdx) * length(dpdy), 1e-20) * 1e-5);
  vec3 gradient = sign(determinant) * (slope.x * r1 + slope.y * r2) / safeDeterminant;
  return mwNormalize(baseNormal - gradient);
}
`;

const colorMixer = node => node.space === 'oklab' ? 'mwColorMixOklab' : 'mwColorMixLinear';

/** Choose one interval; its conversion work is not repeated for other stops. */
function colorRampLines(node, out, uniform) {
  const x = valueName(node.input), colors = node.colors.map(valueName);
  const positions = node.positions.map((_, index) => uniform(`position${index}`));
  const lines = [`  vec3 ${out};`, `  if (${x} <= ${positions[0]}) ${out} = ${colors[0]};`];
  for (let index = 1; index < colors.length; index++) {
    if (node.interpolation === 'constant') {
      lines.push(`  else if (${x} < ${positions[index]}) ${out} = ${colors[index - 1]};`);
    } else if (node.colors[index - 1] === node.colors[index]) {
      lines.push(`  else if (${x} <= ${positions[index]}) ${out} = ${colors[index]};`);
    } else {
      const weight = node.interpolation === 'smoothstep'
        ? `smoothstep(${positions[index - 1]}, ${positions[index]}, ${x})`
        : `(${x} - ${positions[index - 1]}) / (${positions[index]} - ${positions[index - 1]})`;
      lines.push(`  else if (${x} <= ${positions[index]}) ${out} = ${colorMixer(node)}(${colors[index - 1]}, ${colors[index]}, ${weight});`);
    }
  }
  lines.push(`  else ${out} = ${colors.at(-1)};`);
  return lines;
}

export function validateSurfaceShaderPlan(plan) {
  if (!Array.isArray(plan?.nodes) || !plan.nodes.length) throw new TypeError('A compiled surface graph is required.');
  if (plan.nodes.length > SURFACE_SHADER_LIMITS.nodes
      || plan.nodes.filter(node => node.kind === 'facets').length > SURFACE_SHADER_LIMITS.fields
      || plan.nodes.filter(node => node.kind === 'paint').length > SURFACE_SHADER_LIMITS.paints
      || plan.nodes.filter(node => node.kind === 'noise').length > SURFACE_SHADER_LIMITS.proceduralFields
      || plan.nodes.filter(node => node.kind === 'image').length > SURFACE_SHADER_LIMITS.images) {
    throw new RangeError('Surface shader supports at most 256 nodes, 8 facet fields, 16 paint styles, 16 procedural fields, and 6 images.');
  }
}

/** Generate an expression program from the pure compiler's canonical plan. */
export function generateSurfaceShader(plan) {
  validateSurfaceShaderPlan(plan);
  const bindings = graphUniformValues(plan);
  const fields = createFieldShader(plan);
  const names = new Map(bindings.map(binding => [`${binding.id}.${binding.field}`, binding.name]));
  const declarations = bindings.map(binding => `uniform ${binding.type === 'sampler2D' ? 'highp ' : ''}${binding.type} ${binding.name};`).join('\n');
  const lines = ['MoonweaveSurface moonweaveGraph() {', '  vec3 mwRootNormal = mwNormalize(vMoonweaveNormal);', ...fields.prologue];
  for (const node of plan.nodes) {
    if (!/^n\d+$/.test(node.id)) throw new TypeError('Shader generation requires canonical node IDs.');
    const out = valueName(node.id), ref = valueName;
    const uniform = key => names.get(`${node.id}.${key}`);
    const fieldLines = fields.lines(node, uniform);
    if (fieldLines) {
      lines.push(...fieldLines);
      continue;
    }
    switch (node.kind) {
      case 'color': lines.push(`  vec3 ${out} = ${uniform('value')};`); break;
      case 'colorMix': lines.push(`  vec3 ${out} = ${colorMixer(node)}(${ref(node.a)}, ${ref(node.b)}, ${ref(node.mask)});`); break;
      case 'colorAdjust': lines.push(`  vec3 ${out} = mwColorAdjust(${ref(node.input)}, ${ref(node.lightness)}, ${ref(node.chroma)}, ${ref(node.hue)});`); break;
      case 'colorRamp': lines.push(...colorRampLines(node, out, uniform)); break;
      case 'facets':
        lines.push(`  MoonweaveField ${out} = mwSample(${positionName(node.domain)}, ${normalName(node.domain)}, ${uniform('scale')}, ${uniform('stretch')}, ${uniform('direction')}, ${uniform('offset')});`);
        break;
      case 'paint': {
        const palette = key => `clamp(${ref(node.palette[key])}, 0.0, 1.0)`;
        lines.push(`  MoonweaveSurface ${out} = mwPaint(${ref(node.field)}, ${palette('base')}, ${palette('shadow')}, ${palette('light')}, ${uniform('pigment')}, ${uniform('finish')}, ${uniform('response')});`);
        break;
      }
      case 'material': lines.push(`  MoonweaveSurface ${out} = MoonweaveSurface(clamp(${ref(node.color)}, 0.0, 1.0), vec2(0.0), 0.5, 0.0, 0.0, 1.0);`); break;
      case 'coat':
        lines.push(`  MoonweaveSurface ${out} = ${ref(node.input)};`);
        lines.push(`  ${out}.color = mix(${out}.color, clamp(${ref(node.color)}, 0.0, 1.0), clamp(${ref(node.mask)}, 0.0, 1.0));`);
        break;
      case 'deposit': {
        lines.push(`  MoonweaveSurface ${out} = ${ref(node.input)};`);
        const alpha = `mwAlpha_${node.id}`;
        lines.push(`  float ${alpha} = clamp(${ref(node.mask)}, 0.0, 1.0);`);
        lines.push(`  ${out}.color = clamp(${ref(node.color)}, vec3(0.0), vec3(${alpha})) + (1.0 - ${alpha}) * ${out}.color;`);
        for (const channel of ['roughness', 'metalness', 'clearcoat', 'opacity']) if (node[channel] !== undefined) {
          const weight = `${alpha}_${channel}`;
          lines.push(`  float ${weight} = clamp(${ref(node[`${channel}Mask`])}, 0.0, 1.0);`);
          lines.push(`  ${out}.${channel} = clamp(${ref(node[channel])}, 0.0, ${weight}) + (1.0 - ${weight}) * ${out}.${channel};`);
        }
        break;
      }
      case 'mix': lines.push(`  MoonweaveSurface ${out} = mwMix(${ref(node.a)}, ${ref(node.b)}, ${ref(node.mask)});`); break;
      case 'channels':
        lines.push(`  MoonweaveSurface ${out} = ${ref(node.input)};`);
        for (const [channel, input] of Object.entries(node.values)) lines.push(`  ${out}.${channel} = clamp(${ref(input)}, 0.0, 1.0);`);
        break;
      case 'relief':
        lines.push(`  MoonweaveSurface ${out} = ${ref(node.input)};`);
        lines.push(`  ${out}.slope *= ${ref(node.scale)};`);
        break;
      case 'bump':
        lines.push(`  MoonweaveSurface ${out} = ${ref(node.input)};`);
        lines.push(`  ${out}.slope += ${fields.tangent(node.height)};`);
        break;
      default: throw new TypeError(`Unsupported shader graph node: ${node.kind}.`);
    }
  }
  lines.push(`  return ${valueName(plan.output)};`, '}');
  return Object.freeze({declarations: varyings + kernel
    + (plan.cost.paintSamples ? FACETS_GLSL : '')
    + fields.declarations
    + (plan.nodes.some(node => node.kind === 'colorAdjust' || ((node.kind === 'colorMix' || node.kind === 'colorRamp') && node.space === 'oklab')) ? COLOR_GLSL : '')
    + (plan.nodes.some(node => node.kind === 'colorAdjust') ? COLOR_ADJUST_GLSL : '')
    + declarations, evaluate: lines.join('\n')});
}

function replaceOnce(source, anchor, replacement, stage) {
  if (source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) {
    throw new Error(`Unsupported Three.js ${stage} shader: expected exactly one ${anchor}.`);
  }
  return source.replace(anchor, replacement);
}

/** The sole engine shader mutation boundary; a failed injection changes nothing. */
export function patchTexturingShader(shader, uniforms, coordinates, plan) {
  const generated = generateSurfaceShader(plan);
  let vertex = shader.vertexShader, pixel = shader.fragmentShader;
  const attributes = coordinates === 'attribute'
    ? 'attribute vec3 aMoonweavePosition;\nattribute vec3 aMoonweaveNormal;\n' : '';
  vertex = replaceOnce(vertex, '#include <common>', `#include <common>\n${attributes}${varyings}`, 'vertex');
  vertex = replaceOnce(vertex, '#include <begin_vertex>', `
  vMoonweavePosition = ${coordinates === 'attribute' ? 'aMoonweavePosition' : 'position'};
  vMoonweaveNormal = ${coordinates === 'attribute' ? 'aMoonweaveNormal' : 'normal'};
  #include <begin_vertex>`, 'vertex');
  pixel = replaceOnce(pixel, '#include <common>', `#include <common>\n${generated.declarations}\n${generated.evaluate}`, 'fragment');
  pixel = replaceOnce(pixel, 'void main() {', `void main() {
  MoonweaveSurface mwSurface = moonweaveGraph();
  vec3 mwDpdx = dFdx(-vViewPosition), mwDpdy = dFdy(-vViewPosition);`, 'fragment');
  pixel = replaceOnce(pixel, '#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb *= mwSurface.color;
  diffuseColor.a *= mwSurface.opacity;`, 'fragment');
  pixel = replaceOnce(pixel, '#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * mwSurface.roughness, 0.04, 1.0);', 'fragment');
  pixel = replaceOnce(pixel, '#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = clamp(metalnessFactor * mwSurface.metalness, 0.0, 1.0);', 'fragment');
  pixel = replaceOnce(pixel, '#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = moonweaveNormal(normal, mwDpdx, mwDpdy, mwSurface.slope, faceDirection);', 'fragment');
  pixel = replaceOnce(pixel, '#include <clearcoat_normal_fragment_maps>', `#include <clearcoat_normal_fragment_maps>
  #ifdef USE_CLEARCOAT
    clearcoatNormal = moonweaveNormal(clearcoatNormal, mwDpdx, mwDpdy, mwSurface.slope, faceDirection);
  #endif`, 'fragment');
  pixel = replaceOnce(pixel, '#include <lights_physical_fragment>', `#include <lights_physical_fragment>
  #ifdef USE_CLEARCOAT
    material.clearcoat = mwSurface.clearcoat;
  #endif`, 'fragment');
  shader.vertexShader = vertex;
  shader.fragmentShader = pixel;
  Object.assign(shader.uniforms, uniforms);
}

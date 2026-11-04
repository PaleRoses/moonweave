import {scalarIsUniform} from '../core/algebra.mts';
import {imageSampleKey} from '../core/compile.mts';
import {noiseGLSL} from './noise.mjs';
import {IMAGE_GLSL, FILTERED_IMAGE_GLSL} from './images.mts';
import {uniformName} from './uniforms.mts';

export const valueName = id => `mw_${id}`;
export const positionName = id => id === undefined ? 'vMoonweavePosition' : `${valueName(id)}_p`;
export const normalName = id => id === undefined ? 'mwRootNormal' : `${valueName(id)}_n`;
const positionTangent = (id, axis) => `${id === undefined ? 'mwRoot' : valueName(id)}_p${axis}`;
const normalTangent = (id, axis) => `${id === undefined ? 'mwRoot' : valueName(id)}_n${axis}`;
const scalarTangent = id => `${valueName(id)}_d`;
const literal = value => Number.isInteger(value) && Math.abs(value) < 1e21 ? `${value}.0` : String(value);

const normalDifferentials = /* glsl */`
vec3 mwNormalTangent(vec3 raw, vec3 unit, vec3 delta) {
  float magnitude = max(max(max(abs(raw.x), abs(raw.y)), abs(raw.z)), 1e-30);
  vec3 scaled = raw / magnitude, tangent = delta / magnitude;
  return (tangent - unit * dot(unit, tangent))
    * inversesqrt(max(dot(scaled, scaled), 1e-30));
}

vec3 mwTransformNormalSample(mat3 frame, vec3 n, vec3 dx, vec3 dy,
    out vec3 transformedDx, out vec3 transformedDy) {
  // Preserve the value-only normal transform's order and anisotropic scaling.
  vec3 a = frame[0] * n.x, b = frame[1] * n.y, c = frame[2] * n.z;
  vec3 bound = max(max(abs(a), abs(b)), abs(c));
  float magnitude = max(max(max(bound.x, bound.y), bound.z), 1e-30);
  vec3 raw = a / magnitude + b / magnitude + c / magnitude;
  vec3 unit = mwNormalize(raw);
  // Divide before multiplying for large frames, after multiplying for small
  // frames. Scaling the whole matrix would erase inactive anisotropic axes.
  float before = max(magnitude, 1.0), after = min(magnitude, 1.0);
  vec3 tx = (frame[0] * (dx.x / before) + frame[1] * (dx.y / before) + frame[2] * (dx.z / before)) / after;
  vec3 ty = (frame[0] * (dy.x / before) + frame[1] * (dy.y / before) + frame[2] * (dy.z / before)) / after;
  float inverseLength = inversesqrt(max(dot(raw, raw), 1e-30));
  transformedDx = (tx - unit * dot(unit, tx)) * inverseLength;
  transformedDy = (ty - unit * dot(unit, ty)) * inverseLength;
  return unit;
}
`;

/**
 * Demand analytic first differentials only along live bump-height paths.
 * Source attribute tangents come from the fragment quad; the field chain then
 * uses differentiation rules, never finite differences of the final height.
 */
export function createFieldShader(plan) {
  const nodes = new Map(plan.nodes.map(node => [node.id, node]));
  const imageSamples = new Map();
  const uniformScalars = new Set(), scalars = new Set(), positions = new Set(), normals = new Set();
  for (const node of plan.nodes) if (scalarIsUniform(node, id => uniformScalars.has(id))) uniformScalars.add(node.id);

  function domain(id, required) {
    if (required.has(id)) return;
    required.add(id);
    if (id !== undefined) domain(nodes.get(id).input, required);
  }
  function scalar(id) {
    if (uniformScalars.has(id) || scalars.has(id)) return;
    scalars.add(id);
    const node = nodes.get(id);
    switch (node.kind) {
      case 'axis': case 'noise': case 'imageScalar': domain(node.domain, positions); break;
      case 'facing': domain(node.domain, normals); break;
      case 'ramp': case 'complement': scalar(node.input); break;
      case 'add': case 'multiply': scalar(node.a); scalar(node.b); break;
      default: throw new TypeError(`No scalar differential rule for ${node.kind}.`);
    }
  }
  for (const node of plan.nodes) if (node.kind === 'bump') scalar(node.height);
  const images = plan.nodes.filter(node => node.kind === 'imageScalar' || node.kind === 'imageColor');
  // Filter footprints use the unwrapped coordinate map, even for color/finish
  // readers that have no height differential demand.
  for (const node of images) if (node.filter && node.filter !== 'linear') domain(node.domain, positions);

  const tangent = id => uniformScalars.has(id) ? 'vec2(0.0)' : scalarTangent(id);
  const noise = plan.nodes.filter(node => node.kind === 'noise');
  const declarations = noiseGLSL({value: noise.some(node => !scalars.has(node.id)),
    differential: noise.some(node => scalars.has(node.id))}) + (normals.size ? normalDifferentials : '')
    + (images.some(node => (!node.filter || node.filter === 'linear') && node.address !== 'zero') ? IMAGE_GLSL : '')
    + (images.some(node => (node.filter && node.filter !== 'linear') || node.address === 'zero') ? FILTERED_IMAGE_GLSL : '');
  const prologue = [];
  if (positions.has(undefined)) for (const axis of ['x', 'y']) {
    prologue.push(`  vec3 ${positionTangent(undefined, axis)} = dFd${axis}(vMoonweavePosition);`);
  }
  if (normals.has(undefined)) for (const axis of ['x', 'y']) {
    prologue.push(`  vec3 ${normalTangent(undefined, axis)} = mwNormalTangent(vMoonweaveNormal, mwRootNormal, dFd${axis}(vMoonweaveNormal));`);
  }

  function lines(node, uniform) {
    const out = valueName(node.id), ref = valueName, result = [], differentiated = scalars.has(node.id);
    switch (node.kind) {
      case 'image': break;
      case 'imageScalar': case 'imageColor': {
        const key = imageSampleKey(node);
        let sample = imageSamples.get(key);
        if (sample === undefined) {
          sample = out;
          imageSamples.set(key, sample);
          result.push(`  vec3 ${sample}_rgb, ${sample}_du, ${sample}_dv;`);
          const source = uniformName(node.image, 'pixels', 'sampler2D'), size = uniformName(node.image, 'size', 'vec2');
          const output = `${sample}_rgb, ${sample}_du, ${sample}_dv`;
          if (!node.filter || node.filter === 'linear') {
            result.push(node.address === 'zero'
              ? `  mwImageLevel(${source}, ${size}, ${positionName(node.domain)}.xy, 0, 2, ${output});`
              : `  mwImage(${source}, ${size}, ${positionName(node.domain)}.xy, ${node.address === 'repeat' ? 'true' : 'false'}, ${output});`);
          } else {
            result.push(`  mwImageFiltered(${source}, ${size}, ${positionName(node.domain)}.xy, ${positionTangent(node.domain, 'x')}.xy, ${positionTangent(node.domain, 'y')}.xy, ${{clamp: 0, repeat: 1, zero: 2}[node.address]}, ${node.filter === 'anisotropic' ? 'true' : 'false'}, ${output});`);
          }
        }
        if (node.kind === 'imageColor') result.push(`  vec3 ${out} = ${sample}_rgb;`);
        else {
          result.push(`  float ${out} = ${sample}_rgb.${node.channel};`);
          if (differentiated) result.push(`  vec2 ${scalarTangent(node.id)} = vec2(dot(vec2(${sample}_du.${node.channel}, ${sample}_dv.${node.channel}), ${positionTangent(node.domain, 'x')}.xy), dot(vec2(${sample}_du.${node.channel}, ${sample}_dv.${node.channel}), ${positionTangent(node.domain, 'y')}.xy));`);
        }
        break;
      }
      case 'constant': result.push(`  float ${out} = ${literal(node.value)};`); break;
      case 'parameter': result.push(`  float ${out} = ${uniform('value')};`); break;
      case 'noise':
        if (differentiated) {
          result.push(`  vec3 ${out}_gradient;`);
          result.push(`  float ${out} = mwNoiseSample(${positionName(node.domain)}, ${uniform('seed')}, ${out}_gradient);`);
          result.push(`  vec2 ${scalarTangent(node.id)} = vec2(dot(${out}_gradient, ${positionTangent(node.domain, 'x')}), dot(${out}_gradient, ${positionTangent(node.domain, 'y')}));`);
        } else result.push(`  float ${out} = mwNoise(${positionName(node.domain)}, ${uniform('seed')});`);
        break;
      case 'axis':
        result.push(`  float ${out} = ${positionName(node.domain)}.${node.axis};`);
        if (differentiated) result.push(`  vec2 ${scalarTangent(node.id)} = vec2(${positionTangent(node.domain, 'x')}.${node.axis}, ${positionTangent(node.domain, 'y')}.${node.axis});`);
        break;
      case 'facing': {
        const dot = `dot(${normalName(node.domain)}, ${uniform('direction')})`;
        result.push(`  float ${out} = ${node.absolute ? `abs(${dot})` : dot};`);
        if (differentiated) result.push(`  vec2 ${scalarTangent(node.id)} = ${node.absolute ? `sign(${dot}) * ` : ''}vec2(dot(${normalTangent(node.domain, 'x')}, ${uniform('direction')}), dot(${normalTangent(node.domain, 'y')}, ${uniform('direction')}));`);
        break;
      }
      case 'ramp':
        result.push(`  float ${out} = smoothstep(${uniform('edges')}.x, ${uniform('edges')}.y, ${ref(node.input)});`);
        if (differentiated) {
          result.push(`  float ${out}_t = clamp((${ref(node.input)} - ${uniform('edges')}.x) / (${uniform('edges')}.y - ${uniform('edges')}.x), 0.0, 1.0);`);
          result.push(`  vec2 ${scalarTangent(node.id)} = (6.0 * ${out}_t * (1.0 - ${out}_t) / (${uniform('edges')}.y - ${uniform('edges')}.x)) * ${tangent(node.input)};`);
        }
        break;
      case 'add':
        result.push(`  float ${out} = ${ref(node.a)} + ${ref(node.b)};`);
        if (differentiated) result.push(`  vec2 ${scalarTangent(node.id)} = ${tangent(node.a)} + ${tangent(node.b)};`);
        break;
      case 'multiply':
        result.push(`  float ${out} = ${ref(node.a)} * ${ref(node.b)};`);
        if (differentiated) {
          const terms = [];
          if (!uniformScalars.has(node.a)) terms.push(`${tangent(node.a)} * ${ref(node.b)}`);
          if (!uniformScalars.has(node.b)) terms.push(`${ref(node.a)} * ${tangent(node.b)}`);
          result.push(`  vec2 ${scalarTangent(node.id)} = ${terms.join(' + ')};`);
        }
        break;
      case 'complement':
        result.push(`  float ${out} = 1.0 - ${ref(node.input)};`);
        if (differentiated) result.push(`  vec2 ${scalarTangent(node.id)} = -${tangent(node.input)};`);
        break;
      case 'transform':
        result.push(`  vec3 ${out}_p = (${uniform('matrix')} * vec4(${positionName(node.input)}, 1.0)).xyz;`);
        if (normals.has(node.id)) {
          result.push(`  vec3 ${normalTangent(node.id, 'x')}, ${normalTangent(node.id, 'y')};`);
          result.push(`  vec3 ${out}_n = mwTransformNormalSample(${uniform('normalMatrix')}, ${normalName(node.input)}, ${normalTangent(node.input, 'x')}, ${normalTangent(node.input, 'y')}, ${normalTangent(node.id, 'x')}, ${normalTangent(node.id, 'y')});`);
        } else result.push(`  vec3 ${out}_n = mwTransformNormal(${uniform('normalMatrix')}, ${normalName(node.input)});`);
        if (positions.has(node.id)) for (const axis of ['x', 'y']) {
          result.push(`  vec3 ${positionTangent(node.id, axis)} = mat3(${uniform('matrix')}) * ${positionTangent(node.input, axis)};`);
        }
        break;
      default: return undefined;
    }
    return result;
  }
  return {declarations, prologue, lines, tangent};
}

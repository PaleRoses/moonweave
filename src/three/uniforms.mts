import {inverseLinear} from '../core/graph.mts';
import {drawingHash} from '../paint/random.mjs';
import type {GraphNode, GraphNodeOf, ImageResource, SurfaceStyle} from '../core/algebra.mts';
import type {GraphPlan} from '../core/types.mts';

type UniformPayload =
  | {readonly type: 'float' | 'uint'; readonly value: number}
  | {readonly type: 'sampler2D'; readonly value: ImageResource}
  | {readonly type: 'vec2' | 'vec3' | 'vec4' | 'mat3' | 'mat4'; readonly value: readonly number[]};
export type UniformBinding = Readonly<{id: string; field: string; name: string}> & UniformPayload;
export const uniformName = (id: string, field: string, type: UniformPayload['type']): string => `uMw_${id}_${type}_${field}`;
const pigment = ['contrast', 'wash', 'marks', 'quiet'] as const;
const finish = ['roughness', 'roughnessVariation', 'metalness', 'clearcoat'] as const;
const response = ['relief', 'opacity'] as const;
const changed = (value: SurfaceStyle, previous: SurfaceStyle | undefined, keys: readonly (keyof SurfaceStyle)[]) =>
  !previous || keys.some(key => value[key] !== previous[key]);
const sameVector = (a: readonly number[], b: readonly number[] | undefined) =>
  b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);

/** All bindings, or only changed groups within the same validated topology. */
export function nodeUniformValues(node: GraphNode, previous?: GraphNode): UniformBinding[] {
  const values: UniformBinding[] = [];
  const put = (field: string, payload: UniformPayload): void => {
    values.push({id: node.id, field, name: uniformName(node.id, field, payload.type), ...payload});
  };
  const before = <K extends GraphNode['kind']>(kind: K): GraphNodeOf<K> | undefined =>
    previous?.kind === kind ? previous as unknown as GraphNodeOf<K> : undefined;
  switch (node.kind) {
    case 'image':
      if (node.resource !== before('image')?.resource) {
        put('pixels', {type: 'sampler2D', value: node.resource});
        put('size', {type: 'vec2', value: [node.resource.width, node.resource.height]});
      }
      break;
    case 'parameter': if (node.value !== before('parameter')?.value) put('value', {type: 'float', value: node.value}); break;
    case 'noise': if (node.seed !== before('noise')?.seed) put('seed', {type: 'uint', value: node.seed}); break;
    case 'color': if (!sameVector(node.value, before('color')?.value)) put('value', {type: 'vec3', value: node.value}); break;
    case 'colorRamp':
      node.positions.forEach((value, index) => {
        if (value !== before('colorRamp')?.positions[index]) put(`position${index}`, {type: 'float', value});
      });
      break;
    case 'facing': if (!sameVector(node.direction, before('facing')?.direction)) put('direction', {type: 'vec3', value: node.direction}); break;
    case 'ramp':
      if (node.low !== before('ramp')?.low || node.high !== before('ramp')?.high) put('edges', {type: 'vec2', value: [node.low, node.high]});
      break;
    case 'transform': {
      if (sameVector(node.matrix, before('transform')?.matrix)) break;
      const inverse = inverseLinear(node.matrix);
      put('matrix', {type: 'mat4', value: node.matrix});
      put('normalMatrix', {type: 'mat3', value: [inverse[0], inverse[3], inverse[6], inverse[1], inverse[4], inverse[7], inverse[2], inverse[5], inverse[8]]});
      break;
    }
    case 'facets': {
      const old = before('facets');
      if (node.scale !== old?.scale) put('scale', {type: 'float', value: node.scale});
      if (!sameVector(node.stretch, old?.stretch)) put('stretch', {type: 'vec3', value: node.stretch});
      if (node.rotation !== old?.rotation) {
        const angle = node.rotation * Math.PI / 180;
        put('direction', {type: 'vec2', value: [Math.cos(angle), Math.sin(angle)]});
      }
      if (node.seed !== old?.seed) put('offset', {type: 'vec3', value: [31, 67, 109].map(stream => drawingHash(node.seed, stream) * 47)});
      break;
    }
    case 'paint': {
      const style = node.style, old = before('paint')?.style;
      if (changed(style, old, pigment)) put('pigment', {type: 'vec4', value: pigment.map(key => style[key])});
      if (changed(style, old, finish)) put('finish', {type: 'vec4', value: finish.map(key => style[key])});
      if (changed(style, old, response)) put('response', {type: 'vec2', value: response.map(key => style[key])});
      break;
    }
  }
  return values;
}

/** Shader declarations and the adapter share this per-node packing layout. */
export function graphUniformValues(plan: Pick<GraphPlan, 'nodes'>): UniformBinding[] {
  return plan.nodes.flatMap(node => nodeUniformValues(node));
}

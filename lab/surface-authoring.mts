import {materialGraph} from '@moonweave/surfaces/core';
import type {Channel, GraphNode, MaterialGraph} from '@moonweave/surfaces/core';
import {bypassNode, graphIndex, nextId, replaceNode} from './composition.mts';

export const FINISH_FIELDS: readonly {key: Channel; label: string; initial: number}[] = [
  {key: 'roughness', label: 'Roughness', initial: .5},
  {key: 'metalness', label: 'Metalness', initial: 0},
  {key: 'clearcoat', label: 'Clearcoat', initial: 0},
  {key: 'opacity', label: 'Opacity', initial: 1},
];

type BumpNode = Extract<GraphNode, {kind: 'bump'}>;
type ChannelsNode = Extract<GraphNode, {kind: 'channels'}>;

/** Height is an ordinary scalar expression; its amplitude is inside the derivative. */
export function addSurfaceDetail(graph: MaterialGraph, source?: string): MaterialGraph {
  const nodes: GraphNode[] = [...graph.nodes];
  if (source === undefined) {
    const frame = nextId(nodes, 'detailSpace');
    nodes.push({id: frame, kind: 'transform', matrix: [3.4, 0, 0, 0, 0, 3.4, 0, 0, 0, 0, 3.4, 0, 0, 0, 0, 1]});
    source = nextId(nodes, 'detailGrain');
    nodes.push({id: source, kind: 'noise', seed: 53, domain: frame});
  }
  const amplitude = nextId(nodes, 'detailDepth');
  nodes.push({id: amplitude, kind: 'parameter', value: .035});
  const height = nextId(nodes, 'detailHeight');
  nodes.push({id: height, kind: 'multiply', a: amplitude, b: source});
  const id = nextId(nodes, 'detail');
  nodes.push({id, kind: 'bump', input: graph.output, height});
  return materialGraph({...graph, nodes, output: id});
}

function detailAt(graph: MaterialGraph, id: string): BumpNode {
  const node = graphIndex(graph).byId.get(id);
  if (node?.kind !== 'bump') throw new TypeError('Select a height detail.');
  return node;
}

/** Replace the complete height expression. Adding another detail is a separate action. */
export function connectDetailHeight(graph: MaterialGraph, id: string, height: string): MaterialGraph {
  const detail = detailAt(graph, id);
  return detail.height === height ? graph : replaceNode(graph, id, {...detail, height});
}

export function removeSurfaceDetail(graph: MaterialGraph, id: string): MaterialGraph {
  return bypassNode(graph, id, detailAt(graph, id).input);
}

/** Recognize only a uniform factor whose complete use is scaling applied height. */
export function isHeightAmplitude(graph: MaterialGraph, id: string): boolean {
  const index = graphIndex(graph), consumers = index.users.get(id) ?? [];
  return index.byId.get(id)?.kind === 'parameter' && consumers.length > 0 && consumers.every(consumer => {
    const product = index.byId.get(consumer), applications = index.users.get(consumer) ?? [];
    return product?.kind === 'multiply' && applications.length > 0 && applications.every(application => {
      const node = index.byId.get(application);
      return node?.kind === 'bump' && node.height === product.id;
    });
  });
}

/** Bump, relief and pigment coating preserve finish; look through that context. */
export function surfaceFinish(graph: MaterialGraph): ChannelsNode | undefined {
  const index = graphIndex(graph);
  let node = index.byId.get(graph.output)!;
  while (node.kind === 'bump' || node.kind === 'relief' || node.kind === 'coat') node = index.byId.get(node.input)!;
  return node.kind === 'channels' ? node : undefined;
}

/** A finish field overrides one channel; removing it reveals the input surface's finish. */
function connectFinish(graph: MaterialGraph, channel: Channel, source?: string, added: readonly GraphNode[] = []): MaterialGraph {
  const current = surfaceFinish(graph);
  if (current?.values[channel] === source) return graph;
  if (current) {
    const values = {...current.values};
    if (source === undefined) delete values[channel]; else values[channel] = source;
    return Object.keys(values).length
      ? replaceNode(graph, current.id, {...current, values}, added)
      : bypassNode(graph, current.id, current.input);
  }
  const id = nextId(graph.nodes, 'finish');
  return materialGraph({...graph, nodes: [...graph.nodes, ...added, {id, kind: 'channels', input: graph.output, values: {[channel]: source}}], output: id});
}

export function connectSurfaceFinish(graph: MaterialGraph, channel: Channel, source?: string): MaterialGraph {
  return connectFinish(graph, channel, source);
}

/** A new adjustable value retains an existing uniform value when one is connected. */
export function exposeFinishValue(graph: MaterialGraph, channel: Channel): MaterialGraph {
  const current = surfaceFinish(graph), source = current?.values[channel];
  const input = source === undefined ? undefined : graphIndex(graph).byId.get(source);
  const initial = input?.kind === 'constant' || input?.kind === 'parameter'
    ? input.value : FINISH_FIELDS.find(field => field.key === channel)!.initial;
  const id = nextId(graph.nodes, `${channel}Value`);
  return connectFinish(graph, channel, id, [{id, kind: 'parameter', value: initial}]);
}

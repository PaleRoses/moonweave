import {materialGraph, graphTopology} from './graph.mts';
import {
  foldDag, freeze, finite, FLOAT32_MAX, nodeValueKeys,
  scalarIsUniform, SURFACE_SIGNATURE,
} from './algebra.mts';
import type {GraphNode, GraphNodeOf, NodeKind, NodeLike} from './algebra.mts';
import type {GraphTopology} from './graph.mts';
import type {GraphInput, MaterialGraph, GraphPlan, GraphStructure, GraphBinding} from './types.mts';
import {structuralKey} from './intern.mts';
import {analyzeGraph} from './analyze.mts';
import type {AnalysisEntry} from './analyze.mts';
import {hueRadians} from './color.mts';
import {MAX_IMAGE_ANISOTROPY} from './image-filter.mts';

type NodeBody = {[K in NodeKind]: Omit<GraphNodeOf<K>, 'id'>}[NodeKind];
type NodeTemplate = {[K in NodeKind]: Omit<GraphNodeOf<K>,
  keyof ReturnType<(typeof SURFACE_SIGNATURE)[K]['values']['normalize']>>}[NodeKind];
type ImageReader = GraphNodeOf<'imageScalar'> | GraphNodeOf<'imageColor'>;
interface CompiledStructure {
  readonly structure: GraphStructure;
  readonly templates: readonly NodeTemplate[];
  readonly sourceSlots: readonly number[];
  readonly boundNodes: WeakMap<GraphNode, GraphNode>;
  /** Latest value-dependent analysis; bounded by the number of compiled slots. */
  readonly analysis: (AnalysisEntry | undefined)[];
}

// Immutable revisions own plans; shared topology owns lowering and incremental
// analysis. No cache key is a serialized graph and no entry links past revisions.
const plans = new WeakMap<MaterialGraph, GraphPlan>();
const structures = new WeakMap<GraphTopology, CompiledStructure>();

/** Typed readers project one reconstruction when their structural inputs match. */
export const imageSampleKey = (node: ImageReader) => `${node.image}/${node.domain ?? ''}/${node.address}/${node.filter ?? 'linear'}`;

/** A static ceiling: filtered paths can use fewer taps/levels at a given pixel. */
const imageSampleReads = (node: ImageReader) => node.filter === 'anisotropic' ? 8 * MAX_IMAGE_ANISOTROPY
  : node.filter === 'trilinear' ? 8 : 4;

/** Lower topology once. Editable values never participate in specialization. */
function buildStructure(graph: MaterialGraph, topology: GraphTopology): CompiledStructure {
  const temporary: GraphNode[] = [];
  const byTemporary = new Map<string, GraphNode>();
  const common = new Map<string, string>();
  const origins = new Map<string, string>();
  const representatives = new Map<string, string>();
  const uniformScalarIds = new Set<string>();
  let folds = 0, shared = 0;

  function literal(id: string | undefined): number | undefined {
    const node = id === undefined ? undefined : byTemporary.get(id);
    return node?.kind === 'constant' ? node.value : undefined;
  }

  function emit(body: NodeBody | GraphNode): string {
    const {id: ignored, ...content} = body as NodeBody & {id?: string};
    const key = structuralKey(body);
    const existing = key === undefined ? undefined : common.get(key);
    if (existing !== undefined) {
      shared++;
      return existing;
    }
    // The discriminant and all payloads are retained; only the source ID changes.
    const node = {id: `t${temporary.length}`, ...content} as GraphNode;
    temporary.push(node);
    byTemporary.set(node.id, node);
    if (scalarIsUniform<string>(node, id => uniformScalarIds.has(id))) uniformScalarIds.add(node.id);
    if (key !== undefined) common.set(key, node.id);
    return node.id;
  }

  function lower(node: GraphNode, source: GraphNode): string {
    let result: string | undefined;
    switch (node.kind) {
      case 'add': {
        const a = literal(node.a), b = literal(node.b);
        if (a !== undefined && b !== undefined) {
          result = emit({kind: 'constant', value: finite(a + b, 'folded sum', FLOAT32_MAX)});
        } else if (a === 0) result = node.b;
        else if (b === 0) result = node.a;
        break;
      }
      case 'multiply': {
        const a = literal(node.a), b = literal(node.b);
        if (a !== undefined && b !== undefined) {
          result = emit({kind: 'constant', value: finite(a * b, 'folded product', FLOAT32_MAX)});
        } else if (a === 0 || b === 0) result = emit({kind: 'constant', value: 0});
        else if (a === 1) result = node.b;
        else if (b === 1) result = node.a;
        break;
      }
      case 'complement': {
        const x = literal(node.input);
        if (x !== undefined) result = emit({kind: 'constant', value: finite(1 - x, 'folded complement', FLOAT32_MAX)});
        // Preserve nested complements: 1-(1-x) loses tiny x to cancellation.
        // Real-number identities alone cannot justify floating-point rewrites.
        break;
      }
      case 'mix': case 'colorMix': {
        const weight = literal(node.mask);
        if (node.a === node.b) result = node.a;
        else if (weight !== undefined && weight <= 0) result = node.a;
        else if (weight !== undefined && weight >= 1) result = node.b;
        break;
      }
      case 'colorRamp':
        if (node.colors.every(color => color === node.colors[0])) result = node.colors[0];
        break;
      case 'colorAdjust': {
        const hue = literal(node.hue);
        if (literal(node.lightness) === 0 && literal(node.chroma) === 1
            && hue !== undefined && hueRadians(hue) === 0) result = node.input;
        break;
      }
      case 'coat': {
        const weight = literal(node.mask);
        if (weight !== undefined && weight <= 0) result = node.input;
        break;
      }
      case 'channels': {
        if (!Object.keys(node.values).length) {
          result = node.input;
          break;
        }
        const inner = byTemporary.get(node.input)!;
        if (inner.kind === 'channels') {
          // Later overrides win. Keep the signature's order so nested and flat
          // compositions have one program key, regardless of authored order.
          const values = {...inner.values, ...node.values};
          const keys = SURFACE_SIGNATURE.channels.ports.values.keys;
          result = emit({...node, input: inner.input, values: Object.fromEntries(
            keys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]),
          )});
        }
        break;
      }
      case 'relief':
        if (literal(node.scale) === 1) result = node.input;
        break;
      case 'bump':
        if (uniformScalarIds.has(node.height)) result = node.input;
        break;
    }
    if (result !== undefined) folds++;
    else {
      result = emit(node);
      if (nodeValueKeys(node).length) origins.set(result, source.id);
    }
    representatives.set(source.id, result);
    return result;
  }

  const root = foldDag(graph.output, id => graph.nodes[topology.slots[id]], lower);
  const nodes: GraphNode[] = [];
  const sourceIds: (string | undefined)[] = [];
  const live = new Map<string, string>();
  const output = foldDag(root, id => byTemporary.get(id)!, (body, source) => {
    const next = `n${nodes.length}`;
    nodes.push({...body, id: next});
    sourceIds.push(origins.get(source.id));
    live.set(source.id, next);
    return next;
  });
  const bindings: GraphBinding[] = [];
  const sourceSlots: number[] = [];
  const boundNodes = new WeakMap<GraphNode, GraphNode>();
  const templates = nodes.map((node, index) => {
    const keys = nodeValueKeys(node), editable = keys.length > 0;
    const template: {id: string; kind: NodeKind; [key: string]: unknown} = editable ? {...node} : node;
    const slot = editable ? topology.slots[sourceIds[index]!] : -1;
    sourceSlots.push(slot);
    if (editable) {
      for (const key of keys) delete template[key];
      bindings.push({sourceId: sourceIds[index]!, nodeId: node.id, index});
      // Lowering already produced the first bound node; keep that work.
      boundNodes.set(graph.nodes[slot], Object.freeze(node));
    }
    // Only this operation's declared editable payload was removed.
    return template as NodeTemplate;
  });

  // Full structural signature, produced once; no collision-prone short hash.
  const programKey = `moonweave-graph/2:${JSON.stringify({nodes: templates, output})}`;
  let paintSamples = 0, proceduralSamples = 0, uniformScalars = 0;
  const imageSamples = new Map<string, number>();
  // Uniform counts describe the current Three binding layout. They are static
  // work estimates, not a renderer-independent performance or frame-time model.
  for (const node of nodes) {
    if (node.kind === 'facets') {
      paintSamples++;
      uniformScalars += 9;
    } else if (node.kind === 'paint') uniformScalars += 10;
    else if (node.kind === 'parameter') uniformScalars++;
    else if (node.kind === 'transform') uniformScalars += 25;
    else if (node.kind === 'facing') uniformScalars += 3;
    else if (node.kind === 'ramp') uniformScalars += 2;
    else if (node.kind === 'noise') {
      proceduralSamples++;
      uniformScalars++;
    } else if (node.kind === 'color') uniformScalars += 3;
    else if (node.kind === 'colorRamp') uniformScalars += node.positions.length;
    else if (node.kind === 'image') uniformScalars += 2;
    else if (node.kind === 'imageScalar' || node.kind === 'imageColor') {
      imageSamples.set(imageSampleKey(node), imageSampleReads(node));
    }
  }
  if (paintSamples) uniformScalars++;
  const diagnostics = [];
  if (folds) diagnostics.push(`${folds} algebraic simplification${folds === 1 ? '' : 's'}.`);
  if (shared) diagnostics.push(`${shared} repeated reference expression${shared === 1 ? '' : 's'} shared.`);
  if (graph.nodes.length > nodes.length) {
    const removed = graph.nodes.length - nodes.length;
    diagnostics.push(`${removed} source node${removed === 1 ? '' : 's'} eliminated or shared.`);
  }
  // An eliminated child has no live representative; never alias it to its parent.
  const sourceNodes = Object.fromEntries(graph.nodes.map(node => {
    const representative = representatives.get(node.id);
    return [node.id, representative === undefined ? null : live.get(representative) ?? null];
  }));
  const structure = freeze({
    output, programKey, bindings, diagnostics, sourceNodes,
    cost: {
      paintSamples, proceduralSamples,
      textureReads: paintSamples * 4 + [...imageSamples.values()].reduce((sum, reads) => sum + reads, 0),
      uniformScalars,
    },
  });
  return {structure, templates: freeze(templates), sourceSlots, boundNodes, analysis: []};
}

function bindValues(graph: MaterialGraph, compiled: CompiledStructure): readonly GraphNode[] {
  return Object.freeze(compiled.templates.map((template, index) => {
    const slot = compiled.sourceSlots[index];
    // Unbound templates are complete validated nodes. Bound templates regain only
    // the signature-declared values of the same source node and topology slot.
    if (slot < 0) return template as GraphNode;
    const source = graph.nodes[slot];
    let bound = compiled.boundNodes.get(source);
    if (!bound) {
      bound = Object.freeze({...template,
        ...Object.fromEntries(nodeValueKeys(source).map(key => [key, (source as NodeLike)[key]])),
      }) as GraphNode;
      compiled.boundNodes.set(source, bound);
    }
    return bound;
  }));
}

/** Pure observable result; weak identity caches retain no edit-history chain. */
export function compileGraph(input: GraphInput): GraphPlan {
  const graph = materialGraph(input);
  const cached = plans.get(graph);
  if (cached) return cached;
  const topology = graphTopology(graph);
  let compiled = structures.get(topology);
  if (!compiled) {
    compiled = buildStructure(graph, topology);
    structures.set(topology, compiled);
  }
  const nodes = bindValues(graph, compiled), structure = compiled.structure;
  const plan = freeze({
    graph, nodes, structure, ...structure,
    ...analyzeGraph(nodes, structure.output, compiled.analysis),
  });
  plans.set(graph, plan);
  return plan;
}

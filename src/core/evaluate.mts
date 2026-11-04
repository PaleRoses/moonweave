import {expressionGraph, graphTopology} from './graph.mts';
import {freeze, mapReferences, nodeType, record, reference} from './algebra.mts';
import type {NodeKind, NodeLike, ScalarExpression, ColorExpression, DomainExpression} from './algebra.mts';
import {structuralKey} from './intern.mts';
import {createFieldAlgebra, sampleField, sampleDomain} from './field-evaluate.mts';
import type {FieldInterpretation, Point, SampleContext, ScalarSample, ColorSample, DomainSample} from './field-evaluate.mts';
import type {ExpressionGraph, ExpressionInput, GraphDocument} from './types.mts';

export type FieldSamples = {scalar: ScalarSample; color: ColorSample; domain: DomainSample};
export type FieldSort = keyof FieldSamples;
export interface FieldRoot<S extends FieldSort = FieldSort> {readonly id: string; readonly sort: S}
export type FieldRoots = Readonly<Record<string, FieldRoot>>;
export type FieldOutputs<R extends FieldRoots> = {readonly [K in keyof R]: FieldSamples[R[K]['sort']]};
export type FieldSampler<T> = (context?: SampleContext) => T;
export type FieldInput = ScalarExpression | ColorExpression | DomainExpression | ExpressionGraph | GraphDocument;

type FieldSample = FieldSamples[FieldSort];
type FieldValue = FieldInterpretation[keyof FieldInterpretation];
interface CachedField {readonly sort: FieldSort; readonly sample: FieldSampler<FieldSample>}
interface Preparation {
  readonly point: (id: string) => FieldValue;
  readonly samplers: Map<string, CachedField>;
  readonly evidence: () => {sourceNodes: number; preparedNodes: number; sharedNodes: number};
}

// An immutable graph owns one incremental preparation. Sample values never live
// here, and a new revision cannot retain closures over a previous revision.
const fields = new WeakMap<ExpressionGraph, Preparation>();

function preparation(graph: ExpressionGraph): Preparation {
  const previous = fields.get(graph);
  if (previous) return previous;
  const {slots} = graphTopology(graph);
  const points: (FieldValue | undefined)[] = [], representatives: number[] = [];
  const common = new Map<string, number>();
  let sourceNodes = 0, preparedNodes = 0;
  // Heterogeneous dispatch follows the signature's validated typed ports.
  const handlers = createFieldAlgebra() as unknown as Readonly<Partial<Record<NodeKind,
    (node: NodeLike, source: NodeLike) => FieldValue>>>;
  const reference = (id: string) => representatives[slots[id]];
  const point = (id: string): FieldValue => {
    const slot = slots[id], previous = points[slot];
    if (previous !== undefined) return previous;
    const source = graph.nodes[slot];
    const node = mapReferences(source, (child: unknown) => point(child as string));
    // Color point identity controls exact conversion shortcuts and lazy masks.
    // Only pure scalar structure is interned; authored colors remain distinct.
    const key = nodeType(source) === 'scalar' ? structuralKey(source, reference) : undefined;
    const shared = key === undefined ? undefined : common.get(key);
    if (shared !== undefined) {
      representatives[slot] = shared;
      sourceNodes++;
      return points[slot] = points[shared]!;
    }
    const handler = handlers[node.kind];
    if (!handler) throw new TypeError(`The field algebra does not interpret ${node.kind}.`);
    const value = handler(node, source);
    representatives[slot] = slot;
    points[slot] = value;
    sourceNodes++;
    preparedNodes++;
    if (key !== undefined) common.set(key, slot);
    return value;
  };
  const prepared = {point, samplers: new Map<string, CachedField>(),
    evidence: () => ({sourceNodes, preparedNodes, sharedNodes: sourceNodes - preparedNodes})};
  fields.set(graph, prepared);
  return prepared;
}

const fieldSort = (sort: unknown): sort is FieldSort => sort === 'scalar' || sort === 'color' || sort === 'domain';

function rootPoint(graph: ExpressionGraph, id: string, expected?: FieldSort) {
  const node = graph.nodes[graphTopology(graph).slots[id]];
  if (expected !== undefined && (!node || nodeType(node) !== expected)) {
    throw new TypeError(`Expected ${expected} node: ${id}.`);
  }
  if (!node) throw new RangeError(`Unknown graph root: ${id}.`);
  const sort = nodeType(node);
  if (!fieldSort(sort)) {
    throw new TypeError(`CPU field sampling supports scalar, color and domain roots, received ${sort}.`);
  }
  return {sort, point: preparation(graph).point(id) as Point<FieldSample>};
}

/** Internal evidence counts all source nodes prepared for this graph so far. */
export function prepareFieldPoints(graph: ExpressionGraph, ids: readonly string[] = [graph.output]) {
  const roots = ids.map(id => Object.freeze({id, ...rootPoint(graph, id)}));
  return Object.freeze({roots: Object.freeze(roots), ...preparation(graph).evidence()});
}

/** Single-root view of the same graph-owned preparation. */
export function prepareFieldPoint(graph: ExpressionGraph, id = graph.output) {
  const {roots, ...evidence} = prepareFieldPoints(graph, [id]);
  const {sort, point} = roots[0];
  return Object.freeze({sort, point, ...evidence});
}

function fieldSampler<S extends FieldSort>(graph: ExpressionGraph, id: string, sort: S): FieldSampler<FieldSamples[S]> {
  const prepared = preparation(graph);
  let field = prepared.samplers.get(id);
  if (!field) {
    const {point} = rootPoint(graph, id, sort);
    field = {sort, sample: (context = {}) => freeze(sampleField(point, context))};
    prepared.samplers.set(id, field);
  }
  if (field.sort !== sort) throw new TypeError(`Expected ${sort} node: ${id}.`);
  return field.sample as FieldSampler<FieldSamples[S]>;
}

/** Prepare named outputs together; their results share one memo per sample. */
export function createFieldSampler<const R extends FieldRoots>(input: ExpressionInput, roots: R): FieldSampler<FieldOutputs<R>>;
export function createFieldSampler(input: ScalarExpression | ExpressionGraph<'scalar'>): FieldSampler<ScalarSample>;
export function createFieldSampler(input: ColorExpression | ExpressionGraph<'color'>): FieldSampler<ColorSample>;
export function createFieldSampler(input: DomainExpression | ExpressionGraph<'domain'>): FieldSampler<DomainSample>;
export function createFieldSampler(input: FieldInput): FieldSampler<FieldSample>;
export function createFieldSampler(input: ExpressionInput, roots?: FieldRoots): FieldSampler<FieldSample | Readonly<Record<string, FieldSample>>> {
  const graph = expressionGraph(input);
  if (roots !== undefined) {
    record(roots, 'field roots');
    const entries = Object.entries(roots).map(([name, root]) => {
      record(root, `field root ${name}`, ['id', 'sort']);
      reference(root.id, `field root ${name}.id`);
      if (!fieldSort(root.sort)) throw new TypeError(`Expected scalar, color or domain sort for field root ${name}.`);
      const prepared = rootPoint(graph, root.id, root.sort);
      return [name, prepared.point] as const;
    });
    const point: Point<Readonly<Record<string, FieldSample>>> = state =>
      Object.fromEntries(entries.map(([name, point]) => [name, point(state)]));
    return (context = {}) => freeze(sampleField(point, context));
  }
  const sort = graphTopology(graph).sort;
  if (!fieldSort(sort)) {
    throw new TypeError(`CPU field sampling supports scalar, color and domain roots, received ${sort}.`);
  }
  return fieldSampler(graph, graph.output, sort);
}

export function evaluateScalar(input: ExpressionInput, id: string, context: SampleContext = {}): ScalarSample {
  return fieldSampler(expressionGraph(input), id, 'scalar')(context);
}

export function evaluateColor(input: ExpressionInput, id: string, context: SampleContext = {}): ColorSample {
  return fieldSampler(expressionGraph(input), id, 'color')(context);
}

export function evaluateDomain(input: ExpressionInput, id: string | undefined, context: SampleContext = {}): DomainSample {
  const graph = expressionGraph(input);
  return id === undefined ? freeze(sampleDomain(context)) : fieldSampler(graph, id, 'domain')(context);
}

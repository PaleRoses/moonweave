import type {
  GraphExpression, GraphNode, GraphSort, NodeKind, ResultSort, StylePatch,
  SurfaceExpression, SurfacePreset, SURFACE_SIGNATURE,
} from './algebra.mts';

/** Authored names belong to expressions; naming adds no evaluation node. */
export type NamedExpression<E extends GraphExpression, Name extends string = string> = E extends unknown
  ? Readonly<Omit<E, 'id'> & {id: Name}> : never;
export interface InstanceOptions {
  readonly prefix: string;
  readonly shared?: readonly GraphExpression[];
}
export type InstantiatedExpression<E extends GraphExpression> = E extends unknown
  ? Extract<GraphExpression, {kind: E['kind']}> & (E extends {id: string} ? Readonly<{id: string}> : {}) : never;

declare const expressionSort: unique symbol;
/** Normalized documents are v2. The optional symbol is a compile-time root-sort witness. */
export interface ExpressionGraph<S extends GraphSort = GraphSort> {
  readonly version: 2;
  readonly nodes: readonly GraphNode[];
  readonly output: string;
  readonly [expressionSort]?: S;
}
export type MaterialGraph = ExpressionGraph<'surface'>;
/** External documents cross validation once; v1 is accepted only as an import format. */
export interface GraphDocument {
  readonly version: 1 | 2;
  readonly nodes: readonly Readonly<Record<string, unknown>>[];
  readonly output: string;
}
export type GraphInput = MaterialGraph | GraphDocument | SurfaceExpression | SurfacePreset;
export type ExpressionInput = ExpressionGraph | GraphDocument | GraphExpression | SurfacePreset;
export type ExpressionRoot<I extends ExpressionInput> = I extends ExpressionGraph<infer S> ? S
  : I extends GraphExpression ? ResultSort<I['kind']> : I extends SurfacePreset ? 'surface' : GraphSort;
export type RootExpression<S extends GraphSort> = Extract<GraphExpression, {kind: {
  [K in NodeKind]: ResultSort<K> extends S ? K : never
}[NodeKind]}>;

/** Editable data is derived from the grammar, never maintained as a second node union. */
type EditableValues<K extends NodeKind> = ReturnType<(typeof SURFACE_SIGNATURE)[K]['values']['normalize']>;
export type NodeValuePatch = {
  [K in NodeKind]: keyof EditableValues<K> extends never ? never
    : K extends 'paint' ? Readonly<{style?: StylePatch}> : Readonly<Partial<EditableValues<K>>>;
}[NodeKind];
export type GraphPatch = Readonly<Record<string, NodeValuePatch>>;
export interface GraphBinding {
  readonly sourceId: string;
  readonly nodeId: string;
  readonly index: number;
}
export interface GraphCost {
  readonly paintSamples: number;
  readonly proceduralSamples: number;
  readonly textureReads: number;
  readonly uniformScalars: number;
}
/** Value-free live topology, shared by numeric revisions. */
export interface GraphStructure {
  readonly output: string;
  readonly programKey: string;
  readonly bindings: readonly GraphBinding[];
  readonly diagnostics: readonly string[];
  readonly cost: GraphCost;
  readonly sourceNodes: Readonly<Record<string, string | null>>;
}
export interface GraphPlan {
  readonly graph: MaterialGraph;
  readonly nodes: readonly GraphNode[];
  readonly output: string;
  readonly programKey: string;
  readonly structure: GraphStructure;
  readonly bindings: readonly GraphBinding[];
  readonly ranges: Readonly<Record<string, readonly [number, number]>>;
  readonly opacityRange: readonly [number, number];
  readonly diagnostics: readonly string[];
  readonly cost: GraphCost;
}

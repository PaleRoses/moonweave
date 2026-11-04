import {graphJSON} from './serialization.mts';
import {
  FACET_KEYS, PALETTE_KEYS, STYLE_KEYS, splitRecipe, normalizeFacetMapping, normalizePaintStyle,
  normalizePaintPalette,
} from './recipe.mts';
import {
  FLOAT32_MAX, finite, freeze, inverseLinear, record, reference, normalizeNode, patchNodeValues,
  isNodeKind, nodeType, nodeValueKeys, nodeReferences, mapReferences,
  foldDag, interpretGraph, SURFACE_SIGNATURE,
} from './algebra.mts';
import {isOwned, ownValue} from './ownership.mts';
export {ownValue} from './ownership.mts';
import {migrateGraphDocument} from './migrate.mts';
import {srgbToLinear, oklabToLinear, oklchToLinear} from './color.mts';
import {normalizeImage, generateImage, IMAGE_LIMITS} from './resources.mts';
import type {
  GraphNode, GraphSort, GraphExpression, NodeKind, NodeLike,
  ScalarExpression, ColorExpression, FacetExpression, DomainExpression, SurfaceExpression, ImageExpression,
  Vec3, Axis, Channel, ColorSpace, ColorInterpolation, ImageAddress, ImageFilter, ImageChannel,
  FacetMapping, SurfacePreset, SurfacePatch, StylePatch, PaintPalette, PaintPalettePatch, Algebra, Interpretation,
} from './algebra.mts';
import type {
  ExpressionGraph, MaterialGraph, ExpressionInput, ExpressionRoot,
  NamedExpression, InstanceOptions, InstantiatedExpression, GraphPatch, RootExpression,
} from './types.mts';
import type {ImageInput, ImageShape, ImageGenerator} from './resources.mts';

export interface ImageSampleOptions {
  readonly domain?: DomainExpression;
  readonly address?: ImageAddress;
  readonly filter?: ImageFilter;
}
export type ColorRampStop = readonly [position: number, color: ColorExpression];
export interface ColorMixOptions {readonly space?: ColorSpace}
export interface ColorRampOptions extends ColorMixOptions {readonly interpolation?: ColorInterpolation}
export interface ColorAdjustOptions {
  readonly lightness?: ScalarExpression | number;
  readonly chroma?: ScalarExpression | number;
  readonly hue?: ScalarExpression | number;
}
export interface PaintOptions {readonly domain?: DomainExpression; readonly palette?: PaintPalettePatch}


export {FACET_KEYS, PALETTE_KEYS, STYLE_KEYS, splitRecipe};
export {
  FLOAT32_MAX, finite, freeze, inverseLinear, nodeType, nodeValueKeys,
  nodeReferences, mapReferences, foldDag, SURFACE_SIGNATURE,
};

export const GRAPH_VERSION = 2;
export const GRAPH_LIMITS = Object.freeze({nodes: 256, depth: 64, jsonBytes: 16777216, imageComponents: IMAGE_LIMITS.components});
// A topology contains IDs and slots, never a previous graph or value revision.
export interface GraphTopology {
  readonly slots: Readonly<Record<string, number>>;
  readonly sort: GraphSort;
}
const graphs = new WeakMap<object, GraphTopology>();
const expressionGraphs = new WeakMap<object, ExpressionGraph>();
const graphExpressions = new WeakMap<ExpressionGraph, Map<string, NamedExpression<GraphExpression>>>();
const object = (value: unknown): value is object => value !== null && typeof value === 'object';
const expressionNode = (value: unknown): value is NodeLike => object(value) && 'kind' in value && isNodeKind(value.kind);
const ownedGraph = (value: unknown): value is ExpressionGraph => object(value) && graphs.has(value);

function checkImageBudget(nodes: readonly GraphNode[]): void {
  let components = 0;
  for (const node of nodes) if (node.kind === 'image') components += node.resource.data.length;
  if (components > GRAPH_LIMITS.imageComponents) throw new RangeError(`Graph images exceed ${GRAPH_LIMITS.imageComponents} total components.`);
}

export function graphTopology(graph: ExpressionGraph): GraphTopology { return graphs.get(graph)!; }

function expressionDocument(output: unknown) {
  const ordered: NodeLike[] = [], ids = new Map<NodeLike, string | undefined>();
  const reserved = new Set<string>(), visiting = new Set<NodeLike>();
  function visit(expr: unknown, depth=0): void {
    if(depth>GRAPH_LIMITS.depth)throw new RangeError('Graph exceeds maximum depth.');
    if(!expressionNode(expr))throw new TypeError('Expression inputs must be graph expressions, not callbacks or unresolved IDs.');
    if(visiting.has(expr))throw new RangeError('Cyclic graph expression.');
    if(ids.has(expr))return;
    visiting.add(expr);
    if(expr.id!==undefined) {
      const id=reference(expr.id,'expression.id');
      if(reserved.has(id))throw new RangeError(`Duplicate node ID: ${id}.`);
      reserved.add(id);
    }
    for(const {ref} of nodeReferences(expr))visit(ref,depth+1);
    visiting.delete(expr);
    if(ordered.length>=GRAPH_LIMITS.nodes)throw new RangeError('Graph exceeds maximum node count.');
    ids.set(expr,undefined);ordered.push(expr);
  }
  visit(output);
  // Reserve every authored ID before generating any. The postorder preserves
  // existing unnamed documents and lets each reference resolve to an emitted ID.
  let next=0;
  const nodes=ordered.map(expr=>{
    let id=expr.id as string | undefined;
    if(id===undefined) {
      while(reserved.has(`n${next}`))next++;
      id=`n${next++}`;
    }
    ids.set(expr,id);
    return {...mapReferences(expr,child=>ids.get(child as NodeLike)),id};
  });
  return {version:GRAPH_VERSION,nodes,output:ids.get(output as NodeLike)};
}

/** Validate every node and reference, independently of the root expression's sort. */
export function expressionGraph<I extends ExpressionInput>(input: I): ExpressionGraph<ExpressionRoot<I>>;
export function expressionGraph(input: unknown): ExpressionGraph;
export function expressionGraph(input: unknown): ExpressionGraph {
  if (ownedGraph(input)) return input;
  if(typeof input==='string')input=surface.paint(input as SurfacePreset);
  const ownedExpression = expressionNode(input) && isOwned(input) ? input : undefined;
  if (ownedExpression && expressionGraphs.has(ownedExpression)) return expressionGraphs.get(ownedExpression)!;
  const document=migrateGraphDocument((input as {kind?: unknown} | null)?.kind ? expressionDocument(input) : input, GRAPH_LIMITS.nodes);
  record(document,'material graph',['version','nodes','output']);
  if(document.version!==GRAPH_VERSION)throw new RangeError('Unsupported surface graph version.');
  if(!Array.isArray(document.nodes)||!document.nodes.length||document.nodes.length>GRAPH_LIMITS.nodes)throw new RangeError(`Graph requires 1–${GRAPH_LIMITS.nodes} nodes.`);
  const nodes=Array.from(document.nodes, normalizeNode),byId=new Map<string, GraphNode>();
  checkImageBudget(nodes);
  for(const node of nodes){if(byId.has(node.id))throw new RangeError(`Duplicate node ID: ${node.id}.`);byId.set(node.id,node);}
  const output=reference(document.output,'graph.output');
  if(!byId.has(output))throw new RangeError(`Unknown graph output: ${output}.`);
  for(const node of nodes)for(const edge of nodeReferences<string>(node)) {
    const target=byId.get(edge.ref);
    if(!target)throw new RangeError(`Dangling reference ${node.id}.${edge.key}: ${edge.ref}.`);
    if(nodeType(target)!==edge.type)throw new TypeError(`${node.id}.${edge.key} expects ${edge.type}, received ${nodeType(target)}.`);
  }
  const ordered: GraphNode[] = [], state = new Map<string, 1 | 2>(), depths = new Map<string, number>();
  function visit(id: string): number {
    if(state.get(id)===1)throw new RangeError(`Cyclic graph at ${id}.`);
    if(state.get(id)===2)return depths.get(id)!;
    state.set(id,1);let depth=1;
    for(const edge of nodeReferences<string>(byId.get(id)!))depth=Math.max(depth,visit(edge.ref)+1);
    if(depth>GRAPH_LIMITS.depth)throw new RangeError('Graph exceeds maximum depth.');
    state.set(id,2);depths.set(id,depth);ordered.push(byId.get(id)!);return depth;
  }
  visit(output);
  if (ordered.length < nodes.length) {
    for(const id of [...byId.keys()].filter(id => !state.has(id)).sort())visit(id);
  }
  const slots: Record<string, number> = Object.create(null);
  ordered.forEach((node, index) => { slots[node.id] = index; });
  const graph = publishGraph(ordered, output, Object.freeze({slots: Object.freeze(slots), sort: nodeType(byId.get(output)!)}));
  if (ownedExpression) expressionGraphs.set(ownedExpression, graph);
  return graph;
}

/** A material is an expression graph whose root is a surface. */
export function materialGraph(input: unknown): MaterialGraph {
  const graph = expressionGraph(input);
  if (graphTopology(graph).sort !== 'surface') throw new TypeError('Graph output must reference a surface node.');
  return graph as MaterialGraph;
}

/** Reify one reachable root as owned expressions, preserving IDs and DAG sharing. */
export function graphExpression<S extends GraphSort>(input: ExpressionGraph<S>, rootId?: undefined): NamedExpression<RootExpression<S>>;
export function graphExpression(input: ExpressionInput, rootId?: string): NamedExpression<GraphExpression>;
export function graphExpression(input: unknown, rootId?: string): NamedExpression<GraphExpression> {
  const graph = expressionGraph(input), topology = graphTopology(graph);
  const root = rootId ?? graph.output;
  if (topology.slots[root] === undefined) throw new RangeError(`Unknown graph root: ${root}.`);
  let expressions = graphExpressions.get(graph);
  if (!expressions) graphExpressions.set(graph, expressions = new Map());
  const previous = expressions.get(root);
  if (previous) return previous;
  // Retain the traversal memo itself: another root must not walk cached prefixes.
  return foldDag<string, NamedExpression<GraphExpression>>(root, id => graph.nodes[topology.slots[id]],
    node => expression(node.kind, node) as NamedExpression<GraphExpression>, expressions);
}

function publishGraph(nodes: GraphNode[], output: string, topology: GraphTopology): ExpressionGraph {
  const graph = Object.freeze({version: GRAPH_VERSION, nodes: Object.freeze(nodes), output});
  graphs.set(graph, topology);
  return graph;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Persistent value edits. References and literal specialization use a new graph. */
export function patchGraph<I extends ExpressionInput>(input: I, changes: GraphPatch): ExpressionGraph<ExpressionRoot<I>>;
export function patchGraph(input: unknown, changes: unknown): ExpressionGraph {
  const graph = expressionGraph(input), topology = graphTopology(graph);
  record(changes, 'graph patch');
  const replacements = new Map<number, GraphNode>();
  for (const [id, patch] of Object.entries(changes)) {
    const index = topology.slots[id];
    if (index === undefined) throw new RangeError(`Unknown graph node: ${id}.`);
    const current = graph.nodes[index], candidate = patchNodeValues(current, patch);
    if (!sameValue(current, candidate)) replacements.set(index, candidate);
  }
  if (!replacements.size) return graph;
  const nodes = graph.nodes.slice();
  for (const [index, node] of replacements) nodes[index] = node;
  if ([...replacements.values()].some(node => node.kind === 'image')) checkImageBudget(nodes);
  return publishGraph(nodes, graph.output, topology);
}

export function serializeGraph(graph: unknown): string { return graphJSON(expressionGraph(graph)); }
function graphDocument(text: unknown): unknown {
  if(typeof text!=='string' || new TextEncoder().encode(text).length>GRAPH_LIMITS.jsonBytes)throw new RangeError('Graph JSON exceeds the supported size.');
  return JSON.parse(text);
}
export function parseExpressionGraph(text: string): ExpressionGraph { return expressionGraph(graphDocument(text)); }
export function parseGraph(text: string): MaterialGraph { return materialGraph(graphDocument(text)); }

/** Interpret reachable nodes once, using typed ports from the language signature. */
export function foldGraph<R extends Interpretation & {surface: unknown}>(input: MaterialGraph | SurfaceExpression | SurfacePreset, algebra: Algebra<R>): R['surface'];
export function foldGraph<R extends Interpretation & {scalar: unknown}>(input: ScalarExpression | ExpressionGraph<'scalar'>, algebra: Algebra<R>): R['scalar'];
export function foldGraph<R extends Interpretation & {color: unknown}>(input: ColorExpression | ExpressionGraph<'color'>, algebra: Algebra<R>): R['color'];
export function foldGraph<R extends Interpretation & {domain: unknown}>(input: DomainExpression | ExpressionGraph<'domain'>, algebra: Algebra<R>): R['domain'];
export function foldGraph<R extends Interpretation & {facets: unknown}>(input: FacetExpression | ExpressionGraph<'facets'>, algebra: Algebra<R>): R['facets'];
export function foldGraph<R extends Interpretation & {image: unknown}>(input: ImageExpression | ExpressionGraph<'image'>, algebra: Algebra<R>): R['image'];
export function foldGraph<R extends Interpretation>(input: ExpressionInput, algebra: Algebra<R>, rootId?: string): R[keyof R];
export function foldGraph<R extends Interpretation>(input: unknown, algebra: Algebra<R>, rootId?: string): R[keyof R] {
  const graph = expressionGraph(input), topology = graphTopology(graph);
  const root = rootId ?? graph.output;
  if (topology.slots[root] === undefined) throw new RangeError(`Unknown graph root: ${root}.`);
  return interpretGraph(root, id => graph.nodes[topology.slots[id]], algebra);
}

type ExpressionOf<K extends NodeKind> = Extract<GraphExpression, {kind: K}>;
type ExpressionBody<K extends NodeKind> = Omit<ExpressionOf<K>, 'kind'> & {readonly id?: string};
type SamplingBody<K extends 'imageScalar' | 'imageColor'> = Omit<ExpressionBody<K>, 'address' | 'channel'>
  & {readonly address?: ImageSampleOptions['address']; readonly channel?: ImageChannel};
// Constructors retain authored defaults until graph validation. The typed
// boundary checks ports here; normalizeNode supplies complete payloads later.
function expression<K extends 'imageScalar' | 'imageColor'>(kind: K, body: SamplingBody<K>): ExpressionOf<K>;
function expression<K extends NodeKind>(kind: K, body: ExpressionBody<K>): ExpressionOf<K>;
function expression(kind: NodeKind, body: NodeLike): GraphExpression;
function expression(kind: NodeKind, body: Readonly<Record<string, unknown>>): NodeLike {
  // Owned expressions and normalized recipe values are borrowed. Raw author
  // inputs are snapshotted, so construction never freezes the caller's data.
  return ownValue({kind, ...body});
}

/** Internal ownership boundary shared by expression-building modules. */
export function ownExpression<E extends GraphExpression>(input: E): E;
export function ownExpression(input: unknown): GraphExpression;
export function ownExpression(input: unknown): GraphExpression {
  if (!expressionNode(input)) throw new TypeError('Expected a graph expression.');
  return isOwned(input) ? input as GraphExpression : expression(input.kind, input);
}

/** Give an expression an author ID before composing it. This is data, not an alias node. */
export function named<const Name extends string, E extends GraphExpression>(id: Name, input: E): NamedExpression<E, Name>;
export function named(id: string, input: GraphExpression & {readonly id?: string}): NamedExpression<GraphExpression> {
  reference(id,'expression.id');
  if(!expressionNode(input))throw new TypeError('named requires a graph expression.');
  if(isOwned(input)&&input.id===id)return input as NamedExpression<GraphExpression>;
  return expression(input.kind,{...input,id}) as NamedExpression<GraphExpression>;
}

/** One sharing-preserving expression traversal for coordinate binding and instancing. */
function rewriteExpression(input: unknown, rewrite: (body: NodeLike, source: NodeLike) => NodeLike, mapped = new Map<NodeLike, NodeLike>()): NodeLike {
  const visiting = new Set<NodeLike>();
  let count = 0;
  function visit(node: unknown, depth = 0): NodeLike {
    if (!expressionNode(node)) throw new TypeError('Expected a graph expression.');
    if (depth > GRAPH_LIMITS.depth) throw new RangeError('Graph exceeds maximum depth.');
    if (visiting.has(node)) throw new RangeError('Cyclic graph expression.');
    if (mapped.has(node)) return mapped.get(node)!;
    if (++count > GRAPH_LIMITS.nodes) throw new RangeError('Graph exceeds maximum node count.');
    visiting.add(node);
    const body = mapReferences(node, child => visit(child, depth + 1));
    const result = rewrite(body, node);
    visiting.delete(node);
    mapped.set(node, result);
    return result;
  }
  return visit(input);
}

/** Independent local values, scoped author IDs, and explicit borrowed inputs. */
export function instantiate<E extends GraphExpression>(input: E, options: InstanceOptions): InstantiatedExpression<E> {
  record(options, 'instance options', ['prefix', 'shared']);
  const prefix = reference(options.prefix, 'instance prefix');
  const shared = options.shared === undefined ? [] : options.shared;
  if (!Array.isArray(shared)) throw new TypeError('Instance shared inputs must be an array of expressions.');
  if (shared.some(node => !isOwned(node))) {
    throw new TypeError('Instance shared inputs must be Moonweave-owned graph expressions; use constructors or named(id, expression) before composing the template.');
  }
  const mapped = new Map<NodeLike, NodeLike>();
  for (const node of shared) {
    // Borrow each shared root together with all its descendants.
    rewriteExpression(node, (_body, source) => source, mapped);
  }
  return rewriteExpression(input, (body, source) => expression(source.kind, {
    ...body,
    ...(source.id === undefined ? {} : {id: reference(`${prefix}_${reference(source.id, 'expression.id')}`, 'instance node ID')}),
  }), mapped) as InstantiatedExpression<E>;
}

/**
 * Pull a whole expression into a frame. Existing transform chains stay ordered;
 * only their implicit rest inputs are bound. Shared children stay shared.
 */
export function inDomain<E extends GraphExpression>(input: E, frame?: DomainExpression): E {
  if (frame === undefined) return input;
  if (frame?.kind !== 'transform') throw new TypeError('inDomain requires a domain expression.');
  const target = isOwned(frame) ? frame : expression(frame.kind, frame);
  return rewriteExpression(input, (body, node) => {
    let changed = body !== node;
    for (const [key, port] of SURFACE_SIGNATURE[node.kind].portEntries) {
      if (port.kind === 'input' && port.optional && port.sort === 'domain' && body[key] === undefined) {
        body = {...body, [key]: target};
        changed = true;
      }
    }
    return !changed && isOwned(node) ? node : expression(node.kind, body);
  }) as E;
}
const asScalar=(value: number | ScalarExpression): ScalarExpression =>typeof value==='number'?expression('constant',{value}):value;
function imageSample<K extends 'imageScalar' | 'imageColor'>(kind: K, source: ExpressionOf<'image'>, options: ImageSampleOptions & {readonly channel?: ImageChannel} = {}): ExpressionOf<K> {
  record(options, 'image sampling options', kind === 'imageScalar' ? ['domain', 'address', 'channel', 'filter'] : ['domain', 'address', 'filter']);
  return expression(kind, {image: source, ...options} as SamplingBody<K>);
}
function generatedImage(options: ImageShape & {channels: 1}, sample: ImageGenerator<number>): ImageExpression;
function generatedImage(options: ImageShape & {channels: 3}, sample: ImageGenerator<Vec3>): ImageExpression;
function generatedImage(options: ImageShape, sample: ImageGenerator<number | Vec3>): ImageExpression {
  return expression('image', {resource: generateImage(options, sample)});
}
export const image = Object.freeze({
  data: (resource: ImageInput): ImageExpression => expression('image', {resource: normalizeImage(resource)}),
  generate: generatedImage,
});
function colorCoordinates(value: Vec3, name: string): Vec3 {
  if(!Array.isArray(value)||value.length!==3)throw new TypeError(`${name} requires three components.`);
  return Array.from(value,(component,index)=>finite(component,`${name}[${index}]`)) as [number, number, number];
}
export const scalar=Object.freeze({
  image: (source: ImageExpression, options?: ImageSampleOptions & {readonly channel?: ImageChannel}): ExpressionOf<'imageScalar'> => imageSample('imageScalar', source, options),
  constant:(value: number): ExpressionOf<'constant'>=>expression('constant',{value}), parameter:(value: number): ExpressionOf<'parameter'>=>expression('parameter',{value}),
  axis:(axis: Axis='y',domain?: DomainExpression): ExpressionOf<'axis'>=>expression('axis',{axis,...(domain===undefined?{}:{domain})}),
  facing:(direction: Vec3=[0,1,0],domain?: DomainExpression,absolute=false): ExpressionOf<'facing'>=>expression('facing',{direction:[...direction],absolute,...(domain===undefined?{}:{domain})}),
  noise(options: {readonly seed?: number; readonly domain?: DomainExpression}={}): ExpressionOf<'noise'> {
    record(options,'noise expression',['seed','domain']);
    const {seed=0,domain:frame}=options;
    return expression('noise',{seed,...(frame===undefined?{}:{domain:frame})});
  },
  ramp:(input: ScalarExpression | number,low=0,high=1): ExpressionOf<'ramp'>=>expression('ramp',{input:asScalar(input),low,high}),
  add:(a: ScalarExpression | number,b: ScalarExpression | number): ExpressionOf<'add'>=>expression('add',{a:asScalar(a),b:asScalar(b)}),
  multiply:(a: ScalarExpression | number,b: ScalarExpression | number): ExpressionOf<'multiply'>=>expression('multiply',{a:asScalar(a),b:asScalar(b)}),
  complement:(input: ScalarExpression | number): ExpressionOf<'complement'>=>expression('complement',{input:asScalar(input)}),
});
export const color=Object.freeze({
  image: (source: ImageExpression, options?: ImageSampleOptions): ExpressionOf<'imageColor'> => imageSample('imageColor', source, options),
  linear:(value: Vec3): ExpressionOf<'color'>=>expression('color',{value}),
  srgb:(hex: string): ExpressionOf<'color'>=>expression('color',{value:srgbToLinear(hex)}),
  oklab:(value: Vec3): ExpressionOf<'color'>=>expression('color',{value:oklabToLinear(colorCoordinates(value,'Oklab color'))}),
  oklch(value: Vec3): ExpressionOf<'color'> {
    const coordinates=colorCoordinates(value,'OKLCH color');
    if(coordinates[1]<0)throw new RangeError('OKLCH chroma must be nonnegative.');
    return expression('color',{value:oklchToLinear(coordinates)});
  },
  adjust(input: ColorExpression,options: ColorAdjustOptions={}): ExpressionOf<'colorAdjust'> {
    record(options,'color adjustment options',['lightness','chroma','hue']);
    const {lightness=0,chroma=1,hue=0}=options;
    return expression('colorAdjust',{input,lightness:asScalar(lightness),chroma:asScalar(chroma),hue:asScalar(hue)});
  },
  mix(a: ColorExpression,b: ColorExpression,mask: ScalarExpression | number,options: ColorMixOptions={}): ExpressionOf<'colorMix'> {
    record(options,'color mix options',['space']);
    return expression('colorMix',{a,b,mask:asScalar(mask),
      ...(options.space===undefined||options.space==='linear-rgb'?{}:{space:options.space})});
  },
  ramp(input: ScalarExpression | number,stops: readonly ColorRampStop[],options: ColorRampOptions={}): ExpressionOf<'colorRamp'> {
    record(options,'color ramp options',['space','interpolation']);
    if(!Array.isArray(stops))throw new TypeError('Color ramp stops must be [position, color] pairs.');
    const positions: number[] = [], colors: ColorExpression[] = [];
    for(const stop of stops) {
      if(!Array.isArray(stop)||stop.length!==2)throw new TypeError('Color ramp stops must be [position, color] pairs.');
      positions.push(stop[0]);colors.push(stop[1]);
    }
    return expression('colorRamp',{input:asScalar(input),colors,positions,
      space:options.space===undefined?'linear-rgb':options.space,
      interpolation:options.interpolation===undefined?'linear':options.interpolation});
  },
});
export const domain=Object.freeze({transform:(matrix: readonly number[],input?: DomainExpression): DomainExpression=>expression('transform',{matrix:[...matrix],...(input===undefined?{}:{input})})});
export function facets(options: Partial<FacetMapping> & {readonly domain?: DomainExpression}={}): FacetExpression {
  record(options,'facet expression',['domain',...FACET_KEYS]);
  const {domain:frame,...mapping}=options;
  return expression('facets',{...normalizeFacetMapping(mapping),...(frame===undefined?{}:{domain:frame})});
};
export interface DepositChannel {
  readonly value: ScalarExpression | number;
  readonly coverage: ScalarExpression | number;
}
export type DepositChannels = Readonly<Partial<Record<Channel, DepositChannel>>>;

export const surface=Object.freeze({
  material:(color: ColorExpression): ExpressionOf<'material'>=>expression('material',{color}),
  coat:(input: SurfaceExpression,color: ColorExpression,mask: ScalarExpression | number=1): ExpressionOf<'coat'>=>expression('coat',{input,color,mask:asScalar(mask)}),
  paint(input: SurfacePreset | SurfacePatch | FacetExpression='moonstone',
    options: SurfacePreset | StylePatch | PaintOptions={}, palette?: PaintPalettePatch): ExpressionOf<'paint'> {
    if((input as {kind?: unknown} | null)?.kind==='facets') {
      const preset = typeof options === 'string' ? splitRecipe(options) : undefined;
      return expression('paint',{field: input as FacetExpression,
        style: preset?.style ?? normalizePaintStyle(options),
        palette: normalizePaintPalette(palette, preset?.palette)});
    }
    if(palette!==undefined)throw new TypeError('Recipe paint takes palette overrides in its options.');
    record(options,'paint expression',['domain','palette']);
    const placement = options as PaintOptions;
    const parts=splitRecipe(input);
    return expression('paint',{field:facets({...parts.mapping,
      ...(placement.domain===undefined?{}:{domain:placement.domain})}),style:parts.style,
      palette: normalizePaintPalette(placement.palette, parts.palette)});
  },
  /** Associated pigment and finish contributions share their filtered coverage. */
  deposit(input: SurfaceExpression, color: ColorExpression, coverage: ScalarExpression | number,
    channels: DepositChannels = {}): ExpressionOf<'deposit'> {
    record(channels, 'deposition channels', ['roughness', 'metalness', 'clearcoat', 'opacity']);
    const ports: Partial<Record<Channel | `${Channel}Mask`, ScalarExpression>> = {};
    for (const channel of Object.keys(channels) as Channel[]) {
      const contribution: DepositChannel = channels[channel]!;
      record(contribution, `${channel} deposition`, ['value', 'coverage']);
      ports[channel] = asScalar(contribution.value);
      ports[`${channel}Mask`] = asScalar(contribution.coverage);
    }
    return expression('deposit', {input, color, mask: asScalar(coverage), ...ports});
  },
  mix:(a: SurfaceExpression,b: SurfaceExpression,mask: ScalarExpression | number): ExpressionOf<'mix'>=>expression('mix',{a,b,mask:asScalar(mask)}),
  channels:(input: SurfaceExpression,values: Readonly<Partial<Record<Channel, ScalarExpression | number>>>): ExpressionOf<'channels'>=>expression('channels',{input,values:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,asScalar(value)]))}),
  relief:(input: SurfaceExpression,scale: ScalarExpression | number): ExpressionOf<'relief'>=>expression('relief',{input,scale:asScalar(scale)}),
  bump:(input: SurfaceExpression,height: ScalarExpression | number): ExpressionOf<'bump'>=>expression('bump',{input,height:asScalar(height)}),
});

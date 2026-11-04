import {FACET_KEYS, PALETTE_KEYS, normalizeFacetMapping, normalizePaintStyle, patchPaintStyle} from './recipe.mts';
import {normalizeImage} from './resources.mts';

export type GraphSort = 'domain' | 'scalar' | 'color' | 'image' | 'facets' | 'surface';
export type Axis = 'x' | 'y' | 'z';
export type Channel = 'roughness' | 'metalness' | 'clearcoat' | 'opacity';
export type Vec3 = readonly [number, number, number];
export type ColorSpace = 'linear-rgb' | 'oklab';
export type ColorInterpolation = 'linear' | 'smoothstep' | 'constant';
export type PaletteRole = 'base' | 'shadow' | 'light';
export type ImageAddress = 'clamp' | 'repeat' | 'zero';
export type ImageFilter = 'linear' | 'trilinear' | 'anisotropic';
export type ImageChannel = 'r' | 'g' | 'b';
export interface ImageResource {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 3;
  readonly data: readonly number[];
}
export type SurfacePreset = 'moonstone' | 'carapace' | 'horn' | 'membrane' | 'velvet' | 'obsidian';

export interface FacetMapping {
  readonly scale: number;
  readonly stretch: Vec3;
  readonly rotation: number;
  readonly seed: number;
}

export interface SurfaceStyle {
  readonly contrast: number;
  readonly wash: number;
  readonly marks: number;
  readonly quiet: number;
  readonly relief: number;
  readonly roughness: number;
  readonly roughnessVariation: number;
  readonly metalness: number;
  readonly clearcoat: number;
  readonly opacity: number;
}

export interface SurfaceRecipe {
  readonly version: 2;
  readonly mapping: FacetMapping;
  readonly style: SurfaceStyle;
  readonly palette: PaintPalette;
}
export type StylePatch = Readonly<Partial<SurfaceStyle>>;
export interface SurfacePatch {
  readonly version?: 2;
  readonly mapping?: Readonly<Partial<FacetMapping>>;
  readonly style?: StylePatch;
  readonly palette?: PaintPalettePatch;
}

type Data = Readonly<Record<string, unknown>>;
type InputPort<S extends GraphSort = GraphSort, O extends boolean = boolean> = Readonly<{
  kind: 'input'; sort: S; optional: O;
}>;
type RecordPort<S extends GraphSort = GraphSort, K extends string = string, O extends boolean = boolean, C extends boolean = boolean> = Readonly<{
  kind: 'record'; sort: S; keys: readonly K[]; optional: O; complete: C;
}>;
type ListPort<S extends GraphSort = GraphSort> = Readonly<{
  kind: 'list'; sort: S; min: number; max: number;
}>;
type Port = InputPort | RecordPort | ListPort;
type Fields<T extends object> = Readonly<{
  keys: readonly (keyof T & string)[];
  normalize: (input: Data) => T;
}>;

const input = <S extends GraphSort>(sort: S): InputPort<S, false> => Object.freeze({kind: 'input', sort, optional: false});
const optional = <S extends GraphSort>(sort: S): InputPort<S, true> => Object.freeze({kind: 'input', sort, optional: true});
const recordInput = <S extends GraphSort, K extends string, C extends boolean = false>(
  sort: S, keys: readonly K[], complete: C = false as C,
): RecordPort<S, K, false, C> => Object.freeze({kind: 'record', sort, keys, optional: false, complete});
const listInput = <S extends GraphSort>(sort: S, min: number, max: number): ListPort<S> => Object.freeze({kind: 'list', sort, min, max});
const fields = <const K extends readonly string[], T extends Partial<Record<K[number], unknown>>>(
  keys: K, normalize: (input: Data) => T,
): Fields<T> => Object.freeze({keys: Object.freeze([...keys]) as readonly (keyof T & string)[], normalize});
const empty = Object.freeze({});
const none = fields([], () => empty);

function operation<S extends GraphSort, P extends Record<string, Port>, L extends object, V extends object>(
  result: S, ports: P, literals: Fields<L>, values: Fields<V>,
) {
  const portEntries = Object.freeze(Object.entries(ports).map(([key, port]) => Object.freeze([key, port] as const)));
  return Object.freeze({
    result, ports: Object.freeze(ports), portEntries, literals, values,
    keys: Object.freeze(['id', 'kind', ...portEntries.map(([key]) => key), ...literals.keys, ...values.keys]),
  });
}

export const FLOAT32_MAX = 3.4028234663852886e38;
export const CHANNELS: readonly Channel[] = Object.freeze(['roughness', 'metalness', 'clearcoat', 'opacity']);

export function finite(value: unknown, name: string, bound = 1e20): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > bound) {
    throw new RangeError(`${name} must be finite and within ±${bound}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function record<T>(value: T, name: string, keys?: readonly string[]): asserts value is T & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  if (keys) for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new TypeError(`Unknown ${name} property: ${key}.`);
  }
}

export function reference(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z\d_-]{0,63}$/.test(value)) {
    throw new TypeError(`${name} must be a node ID (letters, digits, underscore or hyphen; max 64).`);
  }
  return value;
}

function vector(value: unknown, size: number, name: string): number[] {
  if (!Array.isArray(value) || value.length !== size) throw new TypeError(`${name} requires ${size} components.`);
  return Array.from(value, (component, index) => finite(component, `${name}[${index}]`));
}

export function inverseLinear(matrix: readonly number[]): number[] {
  const [a, d, g, , b, e, h, , c, f, i] = matrix;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  const determinant = a * A + b * D + c * G;
  if (!Number.isFinite(determinant) || determinant === 0) throw new RangeError('Domain matrix must be non-singular.');
  return [A, D, G, B, E, H, C, F, I].map(value => finite(value / determinant, 'inverse domain matrix', FLOAT32_MAX));
}

function affineMatrix(value: unknown): readonly number[] {
  const matrix = vector(value, 16, 'domain matrix');
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
    throw new RangeError('Domain matrix must be affine (column-major).');
  }
  inverseLinear(matrix);
  return matrix;
}

function axis(value: unknown): Axis {
  if (value !== 'x' && value !== 'y' && value !== 'z') throw new RangeError('axis must be x, y or z.');
  return value;
}

function direction(value: unknown): Vec3 {
  const components = vector(value ?? [0, 1, 0], 3, 'facing direction');
  const length = Math.hypot(...components);
  if (length < 1e-12) throw new RangeError('Facing direction must be nonzero.');
  const unit = Math.abs(length - 1) > 1e-12 ? components.map(component => component / length) : components;
  return unit as unknown as Vec3;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('absolute must be boolean.');
  return value;
}

function seed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError('noise.seed must be a uint32.');
  }
  return value === 0 ? 0 : value;
}

function linearColor(value: unknown): Vec3 {
  return vector(value, 3, 'color.value') as unknown as Vec3;
}

function colorSpace(value: unknown): ColorSpace {
  if (value !== 'linear-rgb' && value !== 'oklab') throw new RangeError('Color space must be linear-rgb or oklab.');
  return value;
}

function imageAddress(value: unknown): ImageAddress {
  if (value !== 'clamp' && value !== 'repeat' && value !== 'zero') throw new RangeError('Image address must be clamp, repeat or zero.');
  return value;
}

function imageFilter(value: unknown): {filter?: ImageFilter} {
  // The v55 default remains absent in canonical documents and program keys.
  if (value === undefined || value === 'linear') return {};
  if (value !== 'trilinear' && value !== 'anisotropic') {
    throw new RangeError('Image filter must be linear, trilinear or anisotropic.');
  }
  return {filter: value};
}

function imageChannel(value: unknown): ImageChannel {
  if (value !== 'r' && value !== 'g' && value !== 'b') throw new RangeError('Image channel must be r, g or b.');
  return value;
}

function colorInterpolation(value: unknown): ColorInterpolation {
  if (value !== 'linear' && value !== 'smoothstep' && value !== 'constant') {
    throw new RangeError('Color interpolation must be linear, smoothstep or constant.');
  }
  return value;
}

function rampPositions(value: unknown, colors: unknown): readonly number[] {
  if (!Array.isArray(value) || !Array.isArray(colors) || value.length !== colors.length) {
    throw new TypeError('Color ramp positions must match its color stops.');
  }
  const positions = Array.from(value, (position, index) => finite(position, `color ramp position[${index}]`));
  for (let index = 1; index < positions.length; index++) {
    if (positions[index] - positions[index - 1] < 1e-6
        || Math.fround(positions[index]) <= Math.fround(positions[index - 1])) {
      throw new RangeError('Color ramp positions need increasing float32-representable gaps of at least 0.000001.');
    }
  }
  return positions;
}

/**
 * The language signature: result sorts, reference ports, literal data and editable
 * data live together. Validation, traversal, patches and lowering derive from it.
 */
export const SURFACE_SIGNATURE = Object.freeze({
  image: operation('image', {}, none, fields(['resource'], (data): {resource: ImageResource} => ({resource: normalizeImage(data.resource)}))),
  imageScalar: operation('scalar', {image: input('image'), domain: optional('domain')},
    fields(['address', 'channel', 'filter'], data => ({address: imageAddress(data.address ?? 'clamp'), channel: imageChannel(data.channel ?? 'r'), ...imageFilter(data.filter)})), none),
  imageColor: operation('color', {image: input('image'), domain: optional('domain')},
    fields(['address', 'filter'], data => ({address: imageAddress(data.address ?? 'clamp'), ...imageFilter(data.filter)})), none),
  constant: operation('scalar', {}, fields(['value'], data => ({value: finite(data.value, 'constant.value', FLOAT32_MAX)})), none),
  parameter: operation('scalar', {}, none, fields(['value'], data => ({value: finite(data.value, 'parameter.value')}))),
  axis: operation('scalar', {domain: optional('domain')}, fields(['axis'], data => ({axis: axis(data.axis)})), none),
  facing: operation('scalar', {domain: optional('domain')},
    fields(['absolute'], data => ({absolute: boolean(data.absolute ?? false)})),
    fields(['direction'], data => ({direction: direction(data.direction)}))),
  noise: operation('scalar', {domain: optional('domain')}, none,
    fields(['seed'], data => ({seed: seed(data.seed === undefined ? 0 : data.seed)}))),
  ramp: operation('scalar', {input: input('scalar')}, none, fields(['low', 'high'], data => {
    const low = finite(data.low ?? 0, 'ramp.low'), high = finite(data.high ?? 1, 'ramp.high');
    if (high - low < 1e-6 || Math.fround(high) <= Math.fround(low)) {
      throw new RangeError('ramp edges need a positive float32-representable gap of at least 0.000001.');
    }
    return {low, high};
  })),
  add: operation('scalar', {a: input('scalar'), b: input('scalar')}, none, none),
  multiply: operation('scalar', {a: input('scalar'), b: input('scalar')}, none, none),
  complement: operation('scalar', {input: input('scalar')}, none, none),
  color: operation('color', {}, none, fields(['value'], data => ({value: linearColor(data.value)}))),
  colorMix: operation('color', {a: input('color'), b: input('color'), mask: input('scalar')},
    fields(['space'], (data): {space?: ColorSpace} => data.space === undefined || data.space === 'linear-rgb'
      ? {} : {space: colorSpace(data.space)}), none),
  colorAdjust: operation('color', {
    input: input('color'), lightness: input('scalar'), chroma: input('scalar'), hue: input('scalar'),
  }, none, none),
  colorRamp: operation('color', {input: input('scalar'), colors: listInput('color', 2, 16)},
    fields(['space', 'interpolation'], data => ({
      space: colorSpace(data.space === undefined ? 'linear-rgb' : data.space),
      interpolation: colorInterpolation(data.interpolation === undefined ? 'linear' : data.interpolation),
    })), fields(['positions'], data => ({positions: rampPositions(data.positions, data.colors)}))),
  transform: operation('domain', {input: optional('domain')}, none, fields(['matrix'], data => ({matrix: affineMatrix(data.matrix)}))),
  facets: operation('facets', {domain: optional('domain')}, none,
    fields(FACET_KEYS as readonly (keyof FacetMapping)[], (data): FacetMapping => normalizeFacetMapping(
      Object.fromEntries(FACET_KEYS.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])),
    ) as FacetMapping)),
  paint: operation('surface', {field: input('facets'), palette: recordInput('color', PALETTE_KEYS as readonly PaletteRole[], true)}, none,
    fields(['style'], data => ({style: normalizePaintStyle(data.style as {}) as SurfaceStyle}))),
  material: operation('surface', {color: input('color')}, none, none),
  coat: operation('surface', {input: input('surface'), color: input('color'), mask: input('scalar')}, none, none),
  deposit: operation('surface', {
    input: input('surface'), color: input('color'), mask: input('scalar'),
    roughness: optional('scalar'), roughnessMask: optional('scalar'),
    metalness: optional('scalar'), metalnessMask: optional('scalar'),
    clearcoat: optional('scalar'), clearcoatMask: optional('scalar'),
    opacity: optional('scalar'), opacityMask: optional('scalar'),
  }, none, none),
  mix: operation('surface', {a: input('surface'), b: input('surface'), mask: input('scalar')}, none, none),
  channels: operation('surface', {input: input('surface'), values: recordInput('scalar', CHANNELS)}, none, none),
  relief: operation('surface', {input: input('surface'), scale: input('scalar')}, none, none),
  bump: operation('surface', {input: input('surface'), height: input('scalar')}, none, none),
});

export type NodeKind = keyof typeof SURFACE_SIGNATURE;
type Signature = typeof SURFACE_SIGNATURE;
export type ResultSort<K extends NodeKind> = Signature[K]['result'];
export type NodeKindOf<S extends GraphSort> = {[K in NodeKind]: ResultSort<K> extends S ? K : never}[NodeKind];
type Payload<K extends NodeKind> = ReturnType<Signature[K]['literals']['normalize']> & ReturnType<Signature[K]['values']['normalize']>;
type PortValue<P, R extends Record<GraphSort, unknown>> = P extends RecordPort<infer S, infer K, boolean, infer C>
  ? C extends true ? Readonly<Record<K, R[S]>> : Readonly<Partial<Record<K, R[S]>>>
  : P extends ListPort<infer S> ? readonly R[S][]
    : P extends InputPort<infer S> ? R[S] : never;
type PortValues<P, R extends Record<GraphSort, unknown>> = {
  readonly [K in keyof P as P[K] extends {optional: true} ? never : K]: PortValue<P[K], R>;
} & {
  readonly [K in keyof P as P[K] extends {optional: true} ? K : never]?: PortValue<P[K], R>;
};
export type ResolvedNode<K extends NodeKind, R extends Record<GraphSort, unknown>> = Readonly<
  {kind: K} & Payload<K> & PortValues<Signature[K]['ports'], R>
>;
type NodesOf<S extends GraphSort, R extends Record<GraphSort, unknown>> = {
  [K in NodeKindOf<S>]: ResolvedNode<K, R>
}[NodeKindOf<S>];
interface Expressions {
  image: ImageExpression;
  domain: DomainExpression;
  scalar: ScalarExpression;
  color: ColorExpression;
  facets: FacetExpression;
  surface: SurfaceExpression;
}
export type DomainExpression = NodesOf<'domain', Expressions>;
export type ImageExpression = NodesOf<'image', Expressions>;
export type ScalarExpression = NodesOf<'scalar', Expressions>;
export type ColorExpression = NodesOf<'color', Expressions>;
export type PaintPalette = Readonly<Record<PaletteRole, ColorExpression>>;
export type PaintPalettePatch = Readonly<Partial<PaintPalette>>;
export type FacetExpression = NodesOf<'facets', Expressions>;
export type SurfaceExpression = NodesOf<'surface', Expressions>;
export type GraphExpression = Expressions[GraphSort];
export type GraphNodeOf<K extends NodeKind> = Readonly<{id: string} & ResolvedNode<K, Record<GraphSort, string>>>;
export type GraphNode = {[K in NodeKind]: GraphNodeOf<K>}[NodeKind];

export type Interpretation = Partial<Record<GraphSort, unknown>>;
type Completed<R extends Interpretation> = {[S in GraphSort]: S extends keyof R ? R[S] : never};
/** A handler receives typed interpreted ports, never raw reference IDs. */
export type Algebra<R extends Interpretation> = {
  readonly [K in NodeKind as ResultSort<K> extends keyof R ? K : never]: (
    node: Readonly<{id: string} & ResolvedNode<K, Completed<R>>>, source: GraphNodeOf<K>,
  ) => R[ResultSort<K> & keyof R];
};

export type NodeLike = Readonly<{kind: NodeKind}> & Data;
export interface NodeReference<R = unknown> {key: string; type: GraphSort; ref: R}

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === 'string' && Object.hasOwn(SURFACE_SIGNATURE, value);
}

export function nodeType(node: NodeLike): GraphSort { return SURFACE_SIGNATURE[node.kind].result; }
export function nodeValueKeys(node: NodeLike): readonly string[] { return SURFACE_SIGNATURE[node.kind].values.keys; }

/** Structural spatial constancy; current editable values never decide this fact. */
export function scalarIsUniform<R>(node: NodeLike, uniform: (reference: R) => boolean): boolean {
  switch (node.kind) {
    case 'constant': case 'parameter': return true;
    case 'ramp': case 'complement': return uniform(node.input as R);
    case 'add': case 'multiply': return uniform(node.a as R) && uniform(node.b as R);
    default: return false;
  }
}
const portsOf = (kind: NodeKind): readonly (readonly [string, Port])[] => SURFACE_SIGNATURE[kind].portEntries;

export function nodeReferences<R = unknown>(node: NodeLike): NodeReference<R>[] {
  const references: NodeReference<R>[] = [];
  for (const [key, port] of portsOf(node.kind)) {
    if (port.kind === 'record') {
      for (const [member, ref] of Object.entries((node[key] ?? {}) as Data)) references.push({key: `${key}.${member}`, type: port.sort, ref: ref as R});
    } else if (port.kind === 'list') {
      const values = node[key];
      if (!Array.isArray(values)) throw new TypeError(`${node.kind}.${key} must be a list of ${port.sort} inputs.`);
      for (let index = 0; index < values.length; index++) references.push({key: `${key}[${index}]`, type: port.sort, ref: values[index] as R});
    } else if (node[key] !== undefined) references.push({key, type: port.sort, ref: node[key] as R});
  }
  return references;
}

export function mapReferences<N extends GraphNode>(node: N, transform: (ref: string) => string): N;
export function mapReferences<R>(node: NodeLike, transform: (ref: unknown) => R): NodeLike;
export function mapReferences(node: NodeLike, transform: ((ref: string) => string) | ((ref: unknown) => unknown)): NodeLike {
  let copy: (Record<string, unknown> & {kind: NodeKind}) | undefined;
  const map = transform as (ref: unknown) => unknown;
  for (const [key, port] of portsOf(node.kind)) {
    if (port.kind === 'record') {
      const source = (node[key] ?? {}) as Data;
      let values: Record<string, unknown> | undefined;
      for (const [member, ref] of Object.entries(source)) {
        const value = map(ref);
        if (value !== ref) (values ??= {...source})[member] = value;
      }
      if (values) (copy ??= {...node})[key] = values;
    } else if (port.kind === 'list') {
      const source = node[key] as readonly unknown[];
      let values: unknown[] | undefined;
      for (let index = 0; index < source.length; index++) {
        const value = map(source[index]);
        if (value !== source[index]) (values ??= [...source])[index] = value;
      }
      if (values) (copy ??= {...node})[key] = values;
    } else if (node[key] !== undefined) {
      const value = map(node[key]);
      if (value !== node[key]) (copy ??= {...node})[key] = value;
    }
  }
  return copy ?? node;
}

export function freeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && !seen.has(value)) {
    seen.add(value);
    for (const item of Object.values(value)) freeze(item, seen);
    Object.freeze(value);
  }
  return value;
}

// Only this validator and its value-patch boundary publish canonical nodes.
// Generic expression ownership proves immutability, not normalized payloads.
const normalizedNodes = new WeakSet<object>();

function publishNode(node: Record<string, unknown>): GraphNode {
  const result = freeze(node) as GraphNode;
  normalizedNodes.add(result);
  return result;
}

export function normalizeNode(input: unknown): GraphNode {
  if (input !== null && typeof input === 'object' && normalizedNodes.has(input)) return input as GraphNode;
  const kind = (input as {kind?: unknown} | null)?.kind;
  if (!isNodeKind(kind)) throw new TypeError(`Unknown graph node kind: ${kind}.`);
  const definition = SURFACE_SIGNATURE[kind];
  record(input, 'node', definition.keys);
  const id = reference(input.id, 'node.id');
  const node: Record<string, unknown> = {id, kind};
  for (const [key, port] of portsOf(kind)) {
    if (port.kind === 'record') {
      const values: unknown = input[key] === undefined ? {} : input[key];
      record(values, `${id}.${key}`, port.keys);
      if (port.complete) for (const member of port.keys) {
        if (!Object.hasOwn(values, member)) throw new TypeError(`${id}.${key}.${member} is required.`);
      }
      const entries = port.keys.filter(member => Object.hasOwn(values, member))
        .map(member => [member, reference(values[member], `${id}.${key}.${member}`)]);
      if (!port.optional || entries.length) node[key] = Object.fromEntries(entries);
    } else if (port.kind === 'list') {
      const values = input[key];
      if (!Array.isArray(values) || values.length < port.min || values.length > port.max) {
        throw new RangeError(`${id}.${key} requires ${port.min}–${port.max} ${port.sort} inputs.`);
      }
      node[key] = Array.from(values, (value, index) => reference(value, `${id}.${key}[${index}]`));
    } else if (!port.optional || input[key] !== undefined) node[key] = reference(input[key], `${id}.${key}`);
  }
  if (kind === 'deposit') for (const channel of CHANNELS) {
    if ((node[channel] === undefined) !== (node[`${channel}Mask`] === undefined)) {
      throw new TypeError(`${id}.${channel} and ${channel}Mask must be supplied together.`);
    }
  }
  if (definition.literals.keys.length) Object.assign(node, definition.literals.normalize(input));
  if (definition.values.keys.length) Object.assign(node, definition.values.normalize(input));
  return publishNode(node);
}

/** Normalize editable values while retaining proven literals and connections. */
export function patchNodeValues(input: GraphNode, patch: unknown): GraphNode {
  const node = normalizeNode(input), definition = SURFACE_SIGNATURE[node.kind];
  if (!definition.values.keys.length) throw new TypeError(`${node.kind} is structural; replace the graph to edit ${node.id}.`);
  record(patch, `${node.id} value patch`, definition.values.keys);
  const body: Record<string, unknown> = {...node, ...patch};
  if (node.kind === 'paint' && Object.hasOwn(patch, 'style')) body.style = patchPaintStyle(node.style, patch.style);
  return publishNode({...node, ...definition.values.normalize(body)});
}

/**
 * Memoized DAG catamorphism. Its callers validate graph shape at the boundary.
 * A caller may retain the memo for more roots of the same immutable graph and algebra.
 */
export function foldDag(root: string, read: (id: string) => GraphNode,
  reduce: (mapped: GraphNode, source: GraphNode) => string, values?: Map<string, string>): string;
export function foldDag<K, V>(root: K, read: (key: K) => NodeLike,
  reduce: (mapped: NodeLike, source: NodeLike) => V, values?: Map<K, V>): V;
export function foldDag<K, V>(root: K, read: (key: K) => NodeLike,
  reduce: ((mapped: NodeLike, source: NodeLike) => V) | ((mapped: GraphNode, source: GraphNode) => V),
  values = new Map<K, V>(),
): V {
  // String-to-string lowering preserves every normalized payload and only
  // rewrites reference IDs. The generic fold also supports other interpretations.
  const apply = reduce as (mapped: NodeLike, source: NodeLike) => V;
  function visit(key: K): V {
    if (values.has(key)) return values.get(key)!;
    const source = read(key);
    const result = apply(mapReferences(source, ref => visit(ref as K)), source);
    values.set(key, result);
    return result;
  }
  return visit(root);
}

export function interpretGraph<R extends Interpretation>(
  root: string, read: (id: string) => GraphNode, algebra: Algebra<R>,
): R[keyof R] {
  // The heterogeneous dispatch is safe after the signature's port/type checks.
  const handlers = algebra as unknown as Readonly<Record<string, (node: NodeLike, source: NodeLike) => unknown>>;
  return foldDag<string, unknown>(root, read, (node, source) => {
    const handler = handlers[node.kind];
    if (!handler) throw new TypeError(`The algebra does not interpret ${node.kind}.`);
    return handler(node, source);
  }) as R[keyof R];
}

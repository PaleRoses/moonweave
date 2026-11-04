import type {
  MaterialGraph, GraphNode, GraphSort, SurfacePreset, SurfaceStyle, Axis, PaletteRole,
} from '@moonweave/surfaces/core';

type NodeOf<K extends GraphNode['kind']> = GraphNode & {readonly kind: K};
export type PaintNode = NodeOf<'paint'>;
export type FieldNode = NodeOf<'facets'>;
export type BlendNode = NodeOf<'mix'>;
export type ExpressionControlNode = NodeOf<'parameter' | 'constant' | 'ramp' | 'facing' | 'noise' | 'color' | 'colorMix' | 'colorRamp' | 'colorAdjust' | 'transform'>;
export type SurfaceSourceNode = NodeOf<'paint' | 'material'>;
export type MaskMode = 'uniform' | 'height' | 'facing' | 'custom';
type MaskStep =
  | {readonly node: NodeOf<'complement' | 'ramp'>; readonly edge: 'input'}
  | {readonly node: NodeOf<'multiply'>; readonly edge: 'a' | 'b'};
export interface PaintView {
  readonly id: string;
  readonly mapping: FieldNode;
  readonly style: SurfaceStyle;
  readonly palette: Readonly<Record<PaletteRole, string>>;
  readonly preset: SurfacePreset | null;
  readonly label: string;
}
interface Inspection {
  paintSlots: number[];
  fieldSlots: number[];
  blendSlots: number[];
  sourceSlots: number[];
  surfaceControlSlots: number[];
  users: Map<string, string[]>;
  fieldUsers: Map<string, string[]>;
  maskUsers: Map<string, string[]>;
  maskSlots: Map<string, number[]>;
  live: Set<string>;
}
export interface GraphIndex {
  byId: Map<string, GraphNode>;
  paints: PaintNode[];
  fields: FieldNode[];
  blends: BlendNode[];
  sources: SurfaceSourceNode[];
  surfaceControls: ExpressionControlNode[];
  users: Map<string, string[]>;
  fieldUsers: Map<string, string[]>;
  maskUsers: Map<string, string[]>;
  maskSlots: Map<string, number[]>;
  live: Set<string>;
}
export interface MaskInfo {
  blend: BlendNode;
  controls: ExpressionControlNode[];
  mode: MaskMode;
  strength: NodeOf<'parameter' | 'constant'> | null;
  coordinate: GraphNode | null;
  region: GraphNode;
  /** Ordered edges from the mask to its editable coordinate or uniform value. */
  path: readonly MaskStep[];
}
export interface CompositionOptions {
  base?: SurfacePreset;
  accent?: SurfacePreset | null;
  shared?: boolean;
  mode?: Exclude<MaskMode, 'custom'>;
  axis?: Axis;
  amount?: number;
  center?: number;
  width?: number;
  invert?: boolean;
  bounds?: readonly [number, number] | null;
}

import {materialGraph, surface, splitRecipe, GRAPH_LIMITS} from '@moonweave/surfaces/core';
import {nodeReferences, nodeType, mapReferences, graphTopology} from '../src/core/graph.mts';
import {SURFACE_PRESETS, PALETTE_KEYS} from '../src/core/recipe.mts';
import {migrateSurfaceRecipe} from '../src/core/migrate.mts';

const indices = new WeakMap<MaterialGraph, GraphIndex>(), inspections = new WeakMap<object, Inspection>();
// One latest view per paint node; no graph, revision chain or nested field cache.
const paintViews = new WeakMap<PaintNode, {colors: readonly GraphNode[]; view: PaintView}>();
const presetStyles = new Map((Object.keys(SURFACE_PRESETS) as SurfacePreset[]).map(key => [JSON.stringify(splitRecipe(key).style), key]));
const presetPalettes = new Map((Object.keys(SURFACE_PRESETS) as SurfacePreset[]).map(key => [JSON.stringify(SURFACE_PRESETS[key].recipe.palette), key]));
const editableExpressions = new Set(['parameter', 'constant', 'ramp', 'facing', 'noise', 'color', 'colorMix', 'colorRamp', 'colorAdjust', 'transform']);

function reachable(byId: ReadonlyMap<string, GraphNode>, roots: readonly string[]) {
  const seen = new Set<string>(), pending = [...roots];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    for (const edge of nodeReferences<string>(byId.get(id)!)) pending.push(edge.ref);
  }
  return seen;
}

/** Structural inspection contains only IDs and slots, never previous value revisions. */
export function graphIndex(graph: MaterialGraph): GraphIndex {
  if (indices.has(graph)) return indices.get(graph)!;
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const topology = graphTopology(graph);
  let inspection = inspections.get(topology);
  if (!inspection) {
    const slots = (kind: GraphNode['kind']) => graph.nodes.flatMap((node, index) => node.kind === kind ? [index] : []);
    const paintSlots = slots('paint'), fieldSlots = slots('facets'), blendSlots = slots('mix');
    const sourceSlots = graph.nodes.flatMap((node, slot) => node.kind === 'paint' || node.kind === 'material' ? [slot] : []);
    const users = new Map<string, string[]>();
    for (const node of graph.nodes) for (const ref of new Set(nodeReferences<string>(node).map(edge => edge.ref))) {
      if (!users.has(ref)) users.set(ref, []);
      users.get(ref)!.push(node.id);
    }
    // Literal ramp colors are edited beside their stops. Other users keep the
    // standalone control, so a shared field never loses its editor.
    const isControl = (node: GraphNode) => editableExpressions.has(node.kind)
      && !(node.kind === 'color' && users.get(node.id)?.length
        && users.get(node.id)!.every(id => ['colorRamp', 'paint'].includes(byId.get(id)!.kind)));
    const fieldUsers = new Map(fieldSlots.map(slot => {
      const id = graph.nodes[slot].id;
      return [id, paintSlots.filter(paint => (graph.nodes[paint] as PaintNode).field === id).map(paint => graph.nodes[paint].id)];
    }));
    const maskUsers = new Map<string, string[]>(), maskSlots = new Map<string, number[]>();
    for (const slot of blendSlots) {
      const blend = graph.nodes[slot] as BlendNode, ids = reachable(byId, [blend.mask]);
      maskSlots.set(blend.id, graph.nodes.flatMap((node, index) => ids.has(node.id) && isControl(node) ? [index] : []));
      for (const id of ids) {
        if (!maskUsers.has(id)) maskUsers.set(id, []);
        maskUsers.get(id)!.push(blend.id);
      }
    }
    const live = reachable(byId, [graph.output]);
    const surfaceControlSlots = graph.nodes.flatMap((node, slot) => live.has(node.id) && isControl(node) && !maskUsers.has(node.id) ? [slot] : []);
    inspection = {paintSlots, fieldSlots, blendSlots, sourceSlots, surfaceControlSlots, users, fieldUsers, maskUsers, maskSlots, live};
    inspections.set(topology, inspection);
  }
  const {users, fieldUsers, maskUsers, maskSlots, live} = inspection;
  const at = (slot: number) => graph.nodes[slot];
  const index: GraphIndex = {byId, paints: inspection.paintSlots.map(at) as PaintNode[], fields: inspection.fieldSlots.map(at) as FieldNode[], blends: inspection.blendSlots.map(at) as BlendNode[], sources: inspection.sourceSlots.map(at) as SurfaceSourceNode[], surfaceControls: inspection.surfaceControlSlots.map(at) as ExpressionControlNode[], users, fieldUsers, maskUsers, maskSlots, live};
  indices.set(graph, index);
  return index;
}

function paintView(graph: MaterialGraph, node: PaintNode): PaintView {
  const index = graphIndex(graph), field = index.byId.get(node.field) as FieldNode;
  const colors = PALETTE_KEYS.map(role => index.byId.get(node.palette[role])!);
  const previous = paintViews.get(node);
  let view: PaintView;
  if (previous && colors.every((color, i) => color === previous.colors[i])) {
    if (previous.view.mapping === field) return previous.view;
    view = Object.freeze({...previous.view, mapping: field});
  } else {
    const palette = Object.fromEntries(PALETTE_KEYS.map((role, i) => {
      const color = colors[i];
      return [role, color.kind === 'color' ? {kind: color.kind, value: color.value} : null];
    }));
    const family = presetPalettes.get(JSON.stringify(palette));
    const preset = family && presetStyles.get(JSON.stringify(node.style)) === family ? family : null;
    view = Object.freeze({id: node.id, mapping: field, style: node.style, palette: node.palette,
      preset, label: family ? SURFACE_PRESETS[family].label : node.id});
  }
  paintViews.set(node, {colors, view});
  return view;
}

export function paintsIn(graph: MaterialGraph): PaintView[] { return graphIndex(graph).paints.map(node => paintView(graph, node)); }

export function nextId(nodes: readonly GraphNode[], prefix: string): string {
  const used = new Set(nodes.map(node => node.id));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** A connection can only use the requested sort and cannot depend on its consumer. */
export function sourcesFor(graph: MaterialGraph, consumer: string, sort: GraphSort): GraphNode[] {
  const index = graphIndex(graph), dependent = new Set([consumer]), pending = [consumer];
  while (pending.length) for (const user of index.users.get(pending.pop()!) ?? []) {
    if (!dependent.has(user)) { dependent.add(user); pending.push(user); }
  }
  return graph.nodes.filter(node => nodeType(node) === sort && !dependent.has(node.id));
}

/** Preserve original unused definitions; only newly orphaned live work is removed. */
export function pruneRemovedWork(before: MaterialGraph, nodes: readonly GraphNode[], output: string): MaterialGraph {
  const old = graphIndex(before), byId = new Map(nodes.map(node => [node.id, node]));
  const protectedRoots = before.nodes.filter(node => !old.live.has(node.id) && byId.has(node.id)).map(node => node.id);
  const kept = reachable(byId, [output, ...protectedRoots]);
  return materialGraph({version: 2, nodes: nodes.filter(node => kept.has(node.id)), output});
}

/** Structural edits share validation and remove only work orphaned by this edit. */
export function replaceNode(graph: MaterialGraph, id: string, replacement: GraphNode, added: readonly GraphNode[] = []): MaterialGraph {
  if (replacement.id !== id || !graphIndex(graph).byId.has(id)) throw new TypeError('Select an existing expression to replace.');
  return pruneRemovedWork(graph, [...graph.nodes.map(node => node.id === id ? replacement : node), ...added], graph.output);
}

/** Remove an operation, retaining one of its inputs for every existing user. */
export function bypassNode(graph: MaterialGraph, id: string, input: string): MaterialGraph {
  const nodes = graph.nodes.filter(node => node.id !== id).map(node => mapReferences(node, (ref: string) => ref === id ? input : ref));
  return pruneRemovedWork(graph, nodes, graph.output === id ? input : graph.output);
}

/** Lower preset authoring through the public constructor; assign editor-owned IDs once. */
function appendPreset(nodes: GraphNode[], preset: SurfacePreset, paintId: string, field: string): void {
  const template = materialGraph(surface.paint(preset));
  const names = new Map<string, string>();
  for (const node of template.nodes) {
    const id = node.kind === 'paint' ? paintId : node.kind === 'facets' ? field : nextId(nodes, `${paintId}_${node.kind}`);
    names.set(node.id, id);
    if (node.kind !== 'facets') nodes.push({...mapReferences(node, ref => names.get(ref)!), id});
  }
}

export function appendPaint(graph: MaterialGraph, {field, preset = 'horn'}: {field?: string; preset?: SurfacePreset} = {}): {graph: MaterialGraph; paintId: string; blendId: string} {
  const nodes = [...graph.nodes], parts = splitRecipe(preset);
  if (field === undefined) {
    field = nextId(nodes, 'field'); nodes.push({id: field, kind: 'facets', ...parts.mapping});
  } else if (graphIndex(graph).byId.get(field)?.kind !== 'facets') throw new TypeError('Select a painted field to share.');
  const paintId = nextId(nodes, 'paint'); appendPreset(nodes, preset, paintId, field);
  const amount = nextId(nodes, 'amount'); nodes.push({id: amount, kind: 'parameter', value: .5});
  const blendId = nextId(nodes, 'blend'); nodes.push({id: blendId, kind: 'mix', a: graph.output, b: paintId, mask: amount});
  return {graph: materialGraph({version: 2, nodes, output: blendId}), paintId, blendId};
}

export function removeBlend(graph: MaterialGraph, id: string): MaterialGraph {
  const blend = graphIndex(graph).byId.get(id);
  if (blend?.kind !== 'mix') throw new TypeError('Select a blend to remove.');
  return bypassNode(graph, id, blend.a);
}

export function changePaintField(graph: MaterialGraph, paintId: string, fieldId: string): MaterialGraph {
  const paint = graphIndex(graph).byId.get(paintId);
  if (paint?.kind !== 'paint') throw new TypeError('Select a paint.');
  if (paint.field === fieldId) return graph;
  return replaceNode(graph, paintId, {...paint, field: fieldId});
}
export function separatePaintField(graph: MaterialGraph, paintId: string): MaterialGraph {
  const index = graphIndex(graph), paint = index.byId.get(paintId);
  if (paint?.kind !== 'paint') throw new TypeError('Select a paint.');
  if (index.fieldUsers.get(paint.field)!.length < 2) return graph;
  const field: FieldNode = {...index.byId.get(paint.field) as FieldNode, id: nextId(graph.nodes, 'field')};
  const nodes = graph.nodes.map(node => node.id === paintId ? {...node, field: field.id} : node);
  return materialGraph({...graph, nodes: [...nodes, field]});
}

export function maskInfo(graph: MaterialGraph, blendId: string | null): MaskInfo | null {
  const index = graphIndex(graph), blend = blendId === null ? undefined : index.byId.get(blendId);
  if (blend?.kind !== 'mix') return null;
  const controls = index.maskSlots.get(blend.id)!.map(slot => graph.nodes[slot]) as ExpressionControlNode[];
  const path: MaskStep[] = [];
  const unwrap = (node: GraphNode): GraphNode => {
    while (node.kind === 'complement') {
      path.push({node, edge: 'input'});
      node = index.byId.get(node.input)!;
    }
    return node;
  };
  const node = unwrap(index.byId.get(blend.mask)!);
  const outer = path.length;
  let strength: MaskInfo['strength'] = null, region = node;
  const uniform = (value: GraphNode): value is NonNullable<MaskInfo['strength']> => value.kind === 'parameter' || value.kind === 'constant';
  if (uniform(node)) return {blend, controls, mode: 'uniform', strength: node, coordinate: null, region: node, path};
  if (node.kind === 'multiply') {
    const a = index.byId.get(node.a)!, b = index.byId.get(node.b)!;
    if (uniform(a) && !uniform(b)) { strength = a; region = b; path.push({node, edge: 'b'}); }
    else if (uniform(b) && !uniform(a)) { strength = b; region = a; path.push({node, edge: 'a'}); }
  }
  region = unwrap(region);
  const coordinate = region.kind === 'ramp' ? index.byId.get(region.input)! : null;
  const mode = coordinate?.kind === 'axis' ? 'height' : coordinate?.kind === 'facing' ? 'facing' : 'custom';
  if (mode === 'custom') {
    // A general scalar expression has no distinguished strength or region.
    strength = null; path.length = outer;
  } else path.push({node: region as NodeOf<'ramp'>, edge: 'input'});
  return {blend, controls, mode, strength, coordinate, region, path};
}

/** Replace a coordinate through its exact scalar context; never distribute or cancel complements. */
export function replaceBlendMask(graph: MaterialGraph, blendId: string, mode: Exclude<MaskMode, 'custom'>): MaterialGraph {
  const info = maskInfo(graph, blendId);
  if (!info || !['uniform', 'height', 'facing'].includes(mode)) throw new TypeError('Select a supported region.');
  if (info.mode === mode) return graph;
  const nodes = [...graph.nodes];
  let path = info.path, mask: string;
  if (mode === 'uniform') {
    mask = info.strength?.id ?? nextId(nodes, 'amount');
    if (!info.strength) nodes.push({id: mask, kind: 'parameter', value: info.mode === 'custom' ? .85 : 1});
    // Region-local reversal disappears with the region; full-mask reversal remains.
    const firstInner = path.findIndex(step => step.node.kind !== 'complement');
    path = firstInner < 0 ? path : path.slice(0, firstInner);
  } else {
    mask = nextId(nodes, 'region');
    const frame = info.coordinate && 'domain' in info.coordinate ? {domain: info.coordinate.domain} : {};
    nodes.push(mode === 'height' ? {id: mask, kind: 'axis', axis: 'y', ...frame}
      : {id: mask, kind: 'facing', direction: [0, 1, 0], absolute: false, ...frame});
    if (info.mode === 'uniform' || info.mode === 'custom') {
      let amount = info.strength?.id;
      if (!amount) { amount = nextId(nodes, 'amount'); nodes.push({id: amount, kind: 'parameter', value: .85}); }
      const boundary = nextId(nodes, 'boundary'); nodes.push({id: boundary, kind: 'ramp', input: mask, low: -.45, high: .45});
      mask = nextId(nodes, 'mask'); nodes.push({id: mask, kind: 'multiply', a: boundary, b: amount});
    }
  }
  // Copy only this path. Other blends and channel expressions keep their original references.
  for (let i = path.length - 1; i >= 0; i--) {
    const {node, edge} = path[i], id = nextId(nodes, node.kind);
    nodes.push({...node, id, [edge]: mask});
    mask = id;
  }
  return pruneRemovedWork(graph, nodes.map(node => node.id === blendId ? {...node, mask} : node), graph.output);
}
export function reverseBlendMask(graph: MaterialGraph, blendId: string): MaterialGraph {
  const info = maskInfo(graph, blendId), nodes = [...graph.nodes];
  if (!info) throw new TypeError('Select a blend.');
  const existing = graphIndex(graph).byId.get(info.blend.mask)!;
  let mask = existing.kind === 'complement' ? existing.input : nextId(nodes, 'reverse');
  if (existing.kind !== 'complement') nodes.push({id: mask, kind: 'complement', input: existing.id});
  return pruneRemovedWork(graph, nodes.map(node => node.id === blendId ? {...node, mask} : node), graph.output);
}
export function editLiteral(graph: MaterialGraph, id: string, value: number): MaterialGraph {
  const node = graphIndex(graph).byId.get(id);
  if (node?.kind !== 'constant') throw new TypeError('Select a literal constant.');
  if (node.value === value) return graph;
  return materialGraph({...graph, nodes: graph.nodes.map(node => node.id === id ? {...node, value} : node)});
}

/** Templates are constructors only. Existing graphs are never reverse-engineered into them. */
export function composeSurface({base = 'moonstone', accent = null, shared = true, mode = 'height', axis = 'y', amount = .85, center = 0, width = .9, invert = false, bounds = null}: CompositionOptions = {}): MaterialGraph {
  const a = splitRecipe(base), nodes: GraphNode[] = [{id: 'baseField', kind: 'facets', ...a.mapping}];
  appendPreset(nodes, base, 'basePaint', 'baseField');
  if (!accent) return materialGraph({version: 2, nodes, output: 'basePaint'});
  const b = splitRecipe(accent);
  if (!shared) nodes.push({id: 'accentField', kind: 'facets', ...b.mapping});
  appendPreset(nodes, accent, 'accentPaint', shared ? 'baseField' : 'accentField');
  nodes.push({id: 'amount', kind: 'parameter', value: amount});
  let mask = 'amount';
  if (mode !== 'uniform') {
    const direction = ({x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]} as const)[axis];
    nodes.push(mode === 'height' ? {id: 'region', kind: 'axis', axis} : {id: 'region', kind: 'facing', direction, absolute: false});
    nodes.push({id: 'boundary', kind: 'ramp', input: 'region', low: bounds?.[0] ?? center - width / 2, high: bounds?.[1] ?? center + width / 2});
    let region = 'boundary';
    if (invert) { nodes.push({id: 'reversed', kind: 'complement', input: region}); region = 'reversed'; }
    nodes.push({id: 'mask', kind: 'multiply', a: region, b: 'amount'}); mask = 'mask';
  }
  nodes.push({id: 'surface', kind: 'mix', a: 'basePaint', b: 'accentPaint', mask});
  return materialGraph({version: 2, nodes, output: 'surface'});
}

export function parseSurface(text: string): MaterialGraph {
  if (new TextEncoder().encode(text).length > GRAPH_LIMITS.jsonBytes) throw new RangeError(`Surface source exceeds ${GRAPH_LIMITS.jsonBytes} bytes.`);
  const data = JSON.parse(text);
  return data && Array.isArray(data.nodes) ? materialGraph(data) : materialGraph(surface.paint(migrateSurfaceRecipe(data)));
}

import {color, materialGraph, PALETTE_KEYS, SURFACE_PRESETS, evaluateColor} from '@moonweave/surfaces/core';
import type {ColorInterpolation, ColorSpace, GraphNode, MaterialGraph, PaletteRole, SurfacePreset, Vec3} from '@moonweave/surfaces/core';
import {mapReferences, nodeReferences, nodeType} from '../src/core/graph.mts';
import {mixColorSamples} from '../src/core/color-sample.mts';
import {bypassNode, graphIndex, nextId, replaceNode as replace, sourcesFor} from './composition.mts';

type ColorRamp = Extract<GraphNode, {kind: 'colorRamp'}>;
type ColorAdjustment = Extract<GraphNode, {kind: 'colorAdjust'}>;

export const COLOR_ADJUSTMENTS = [
  {key: 'lightness', label: 'Lightness offset', initial: 0, min: -.5, max: .5, step: .005},
  {key: 'chroma', label: 'Chroma scale', initial: 1, min: 0, max: 2, step: .01},
  {key: 'hue', label: 'Hue rotation (°)', initial: 0, min: -180, max: 180, step: 1},
] as const;
export type ColorAdjustmentPort = typeof COLOR_ADJUSTMENTS[number]['key'];

function adjustmentAt(graph: MaterialGraph, id: string): ColorAdjustment {
  const node = graphIndex(graph).byId.get(id);
  if (node?.kind !== 'colorAdjust') throw new TypeError('Select a color adjustment.');
  return node;
}

/** Wrap connected uses without renaming or copying the original color field. */
export function addColorAdjustment(graph: MaterialGraph, input: string): MaterialGraph {
  const index = graphIndex(graph), source = index.byId.get(input);
  if (!source || nodeType(source) !== 'color') throw new TypeError('Select a color field.');
  if (!index.users.get(input)?.length) throw new TypeError('Connect this color before adjusting it.');
  const added: GraphNode[] = [];
  const ports = Object.fromEntries(COLOR_ADJUSTMENTS.map(control => {
    const id = nextId([...graph.nodes, ...added], `color${control.key[0].toUpperCase()}${control.key.slice(1)}`);
    added.push({id, kind: 'parameter', value: control.initial});
    return [control.key, id];
  })) as Record<ColorAdjustmentPort, string>;
  const id = nextId([...graph.nodes, ...added], 'adjustedColor');
  added.push({id, kind: 'colorAdjust', input, ...ports});
  const nodes = graph.nodes.map(node => mapReferences(node, (ref: string) => ref === input ? id : ref));
  return materialGraph({...graph, nodes: [...nodes, ...added]});
}

export function connectColorAdjustment(graph: MaterialGraph, id: string, port: 'input' | ColorAdjustmentPort, source: string): MaterialGraph {
  const node = adjustmentAt(graph, id);
  return node[port] === source ? graph : replace(graph, id, {...node, [port]: source});
}

/** Copy a uniform value into an independent live parameter; fields start neutral. */
export function exposeColorAdjustmentValue(graph: MaterialGraph, id: string, port: ColorAdjustmentPort, value?: number): MaterialGraph {
  const node = adjustmentAt(graph, id), source = graphIndex(graph).byId.get(node[port]);
  const initial = value ?? (source?.kind === 'constant' || source?.kind === 'parameter'
    ? source.value : COLOR_ADJUSTMENTS.find(control => control.key === port)!.initial);
  const input = nextId(graph.nodes, `color${port[0].toUpperCase()}${port.slice(1)}`);
  return replace(graph, id, {...node, [port]: input}, [{id: input, kind: 'parameter', value: initial}]);
}

export function removeColorAdjustment(graph: MaterialGraph, id: string): MaterialGraph {
  return bypassNode(graph, id, adjustmentAt(graph, id).input);
}

/** Dedicated adjustment values are already editable beside the connected color. */
export function isInlineColorValue(graph: MaterialGraph, id: string): boolean {
  const index = graphIndex(graph), node = index.byId.get(id), users = index.users.get(id) ?? [];
  return (node?.kind === 'parameter' || node?.kind === 'constant') && users.length > 0
    && users.every(user => index.byId.get(user)?.kind === 'colorAdjust');
}

/** Only offer color fields that cannot make the selected input cyclic. */
export function colorSources(graph: MaterialGraph, consumer: string): GraphNode[] {
  return sourcesFor(graph, consumer, 'color');
}

export function changePaintPalette(graph: MaterialGraph, id: string, role: PaletteRole, source: string): MaterialGraph {
  const paint = graphIndex(graph).byId.get(id);
  if (paint?.kind !== 'paint' || !PALETTE_KEYS.includes(role)) throw new TypeError('Select a paint pigment.');
  if (paint.palette[role] === source) return graph;
  return replace(graph, id, {...paint, palette: {...paint.palette, [role]: source}});
}

/** An independent color begins at the connected field's value at the rest origin. */
export function separatePaintColor(graph: MaterialGraph, id: string, role: PaletteRole): MaterialGraph {
  const paint = graphIndex(graph).byId.get(id);
  if (paint?.kind !== 'paint') throw new TypeError('Select a paint pigment.');
  const value = evaluateColor(graph, paint.palette[role], {position: [0, 0, 0]}).value;
  const input = nextId(graph.nodes, `${role}Color`);
  return replace(graph, id, {...paint, palette: {...paint.palette, [role]: input}}, [{id: input, ...color.linear(value)}]);
}

export function changeColorProgram(graph: MaterialGraph, id: string, settings: {space?: ColorSpace; interpolation?: ColorInterpolation}): MaterialGraph {
  const node = graphIndex(graph).byId.get(id);
  if (node?.kind !== 'colorMix' && node?.kind !== 'colorRamp') throw new TypeError('Select a color mixture or ramp.');
  if (node.kind === 'colorMix' && settings.interpolation !== undefined) throw new TypeError('A two-color mixture has no ramp curve.');
  const space = settings.space ?? node.space ?? 'linear-rgb';
  if (space === (node.space ?? 'linear-rgb') && (node.kind === 'colorMix' || (settings.interpolation ?? node.interpolation) === node.interpolation)) return graph;
  return replace(graph, id, node.kind === 'colorMix' ? {...node, space}
    : {...node, space, interpolation: settings.interpolation ?? node.interpolation});
}

function rampAt(graph: MaterialGraph, id: string): ColorRamp {
  const node = graphIndex(graph).byId.get(id);
  if (node?.kind !== 'colorRamp') throw new TypeError('Select a color ramp.');
  return node;
}

export function changeRampColor(graph: MaterialGraph, id: string, stop: number, source: string): MaterialGraph {
  const node = rampAt(graph, id);
  if (!Number.isInteger(stop) || stop < 0 || stop >= node.colors.length) throw new RangeError('Select a ramp stop.');
  if (node.colors[stop] === source) return graph;
  const colors = [...node.colors]; colors[stop] = source;
  return replace(graph, id, {...node, colors});
}

function insertion(node: ColorRamp): {left: number; position: number} | undefined {
  if (node.colors.length >= 16) return;
  let chosen: {left: number; position: number} | undefined, width = 0;
  for (let left = 0; left < node.positions.length - 1; left++) {
    const low = node.positions[left], high = node.positions[left + 1], position = low + (high - low) / 2;
    if (position - low >= 1e-6 && high - position >= 1e-6
        && Math.fround(position) > Math.fround(low) && Math.fround(high) > Math.fround(position)
        && high - low > width) { chosen = {left, position}; width = high - low; }
  }
  return chosen;
}

export function canAddRampStop(graph: MaterialGraph, id: string): boolean { return insertion(rampAt(graph, id)) !== undefined; }

/** Add the current midpoint color; varying endpoints stay composed fields. */
export function addRampStop(graph: MaterialGraph, id: string): MaterialGraph {
  const node = rampAt(graph, id), slot = insertion(node);
  if (!slot) throw new RangeError('No room for another stop: keep fewer than 16 stops and leave representable intervals.');
  const {left, position} = slot, at = left + 1;
  const index = graphIndex(graph), a = index.byId.get(node.colors[left])!, b = index.byId.get(node.colors[at])!;
  const added: GraphNode[] = [], colors = [...node.colors], positions = [...node.positions];
  let source = a.id;
  const zero = [0, 0, 0] as const;
  const t = (position - node.positions[left]) / (node.positions[at] - node.positions[left]);
  const weight = node.interpolation === 'smoothstep' ? t * t * (3 - 2 * t) : t;
  let value: Vec3 | undefined;
  if (a.kind === 'color') {
    if (node.interpolation === 'constant') value = a.value;
    else if (b.kind === 'color') value = mixColorSamples(
      {value: a.value, dx: zero, dy: zero}, {value: b.value, dx: zero, dy: zero},
      {value: weight, dx: 0, dy: 0}, node.space).value;
  }
  if (value && value.every(component => Math.abs(component) <= 1e20)) {
    source = nextId(graph.nodes, 'stopColor'); added.push({id: source, kind: 'color', value});
  } else if (node.interpolation !== 'constant') {
    const mask = nextId(graph.nodes, 'stopMidpoint');
    added.push({id: mask, kind: 'constant', value: weight});
    source = nextId([...graph.nodes, ...added], 'stopBlend');
    added.push({id: source, kind: 'colorMix', a: a.id, b: b.id, mask, space: node.space});
  }
  colors.splice(at, 0, source); positions.splice(at, 0, position);
  return replace(graph, id, {...node, colors, positions}, added);
}

export function removeRampStop(graph: MaterialGraph, id: string, stop: number): MaterialGraph {
  const node = rampAt(graph, id);
  if (node.colors.length <= 2) throw new RangeError('A color ramp needs at least two stops.');
  if (!Number.isInteger(stop) || stop < 0 || stop >= node.colors.length) throw new RangeError('Select a ramp stop.');
  return replace(graph, id, {...node, colors: node.colors.filter((_, i) => i !== stop), positions: node.positions.filter((_, i) => i !== stop)});
}

/** Presets replace only this paint's connections; shared colors keep their other users. */
export function resetPaintPalette(graph: MaterialGraph, id: string, preset: SurfacePreset): MaterialGraph {
  const paint = graphIndex(graph).byId.get(id);
  if (paint?.kind !== 'paint') throw new TypeError('Select a paint pigment.');
  const added: GraphNode[] = [];
  const palette = Object.fromEntries(PALETTE_KEYS.map(role => {
    const input = nextId([...graph.nodes, ...added], `${role}Color`);
    added.push({id: input, ...SURFACE_PRESETS[preset].recipe.palette[role]} as GraphNode);
    return [role, input];
  })) as Record<PaletteRole, string>;
  return replace(graph, id, {...paint, palette}, added);
}

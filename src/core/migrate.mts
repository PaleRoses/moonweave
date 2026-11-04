import {FACET_KEYS, PALETTE_KEYS, STYLE_KEYS, normalizeSurfaceRecipe, normalizePaintStyle, normalizePaintPalette} from './recipe.mts';
import {srgbToLinear} from './color.mts';
import type {SurfaceRecipe, ColorExpression} from './algebra.mts';

function record<T>(value: T, name: string, keys?: readonly string[]): asserts value is T & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${name} must be a plain object.`);
  if (keys) for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`Unknown ${name} property: ${key}.`);
}

/** The only decoder for the former style-owned sRGB swatches. */
function legacyPaint(input: unknown = {}) {
  if (typeof input === 'string') return normalizeSurfaceRecipe(input);
  record(input, 'legacy paint style', [...STYLE_KEYS, 'palette']);
  const {palette = {}, ...style} = input;
  record(palette, 'legacy palette', PALETTE_KEYS);
  const colors: Partial<Record<(typeof PALETTE_KEYS)[number], ColorExpression>> = {};
  for (const key of PALETTE_KEYS) if (Object.hasOwn(palette, key)) {
    if (typeof palette[key] !== 'string') throw new TypeError(`palette.${key} must be a six-digit sRGB hex color.`);
    colors[key] = {kind: 'color', value: srgbToLinear(palette[key])};
  }
  return {style: normalizePaintStyle(style), palette: normalizePaintPalette(colors)};
}

/** Explicit import boundary for saved flat v1 recipes; always returns canonical v2. */
export function migrateSurfaceRecipe(input: unknown): SurfaceRecipe {
  if (typeof input === 'string') return normalizeSurfaceRecipe(input);
  record(input, 'legacy recipe');
  if (input.version === 2) return normalizeSurfaceRecipe(input);
  record(input, 'legacy recipe', ['version', ...FACET_KEYS, ...STYLE_KEYS, 'palette']);
  if (input.version !== undefined && input.version !== 1) throw new RangeError('Unsupported Moonweave surface recipe version.');
  const mapping = Object.fromEntries(FACET_KEYS.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  const appearance = Object.fromEntries([...STYLE_KEYS, 'palette'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  return normalizeSurfaceRecipe({mapping, ...legacyPaint(appearance)});
}

/** v1 is accepted at import only. No legacy palette reaches validation or lowering. */
export function migrateGraphDocument(input: unknown, maxNodes: number): unknown {
  if (!input || typeof input !== 'object' || !('version' in input) || input.version !== 1) return input;
  record(input, 'material graph', ['version', 'nodes', 'output']);
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > maxNodes) {
    throw new RangeError(`Graph requires 1–${maxNodes} nodes before migration.`);
  }
  const reserved = new Set(input.nodes.map(node => node?.id));
  let serial = 0;
  const nodes: Record<string, unknown>[] = [];
  for (const raw of input.nodes) {
    record(raw, 'node');
    if (raw.kind !== 'paint') { nodes.push(raw); continue; }
    const {style, palette: legacyColors} = legacyPaint(raw.style);
    const supplied = raw.palette === undefined ? {} : raw.palette;
    record(supplied, 'paint palette', PALETTE_KEYS);
    const palette: Record<string, unknown> = {...supplied};
    for (const role of PALETTE_KEYS) if (!Object.hasOwn(palette, role)) {
      let id: string;
      do { id = `legacyColor${serial++}`; } while (reserved.has(id));
      reserved.add(id);
      nodes.push({id, ...legacyColors[role]});
      palette[role] = id;
    }
    nodes.push({...raw, style, palette});
  }
  return {version: 2, nodes, output: input.output};
}

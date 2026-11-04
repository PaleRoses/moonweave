import {srgbToLinear} from './color.mts';
import {ownValue, ownFrozen, isOwned} from './ownership.mts';
import type {FacetMapping, SurfaceStyle, SurfaceRecipe, SurfacePreset, SurfacePatch,
  PaletteRole, PaintPalette, PaintPalettePatch, ColorExpression, Vec3} from './algebra.mts';

/** Recipes are authoring data. Every palette role is a linear color expression. */
export const SURFACE_RECIPE_VERSION = 2;
export const FACET_KEYS: readonly (keyof FacetMapping)[] = Object.freeze(['scale', 'stretch', 'rotation', 'seed']);
export const PALETTE_KEYS: readonly PaletteRole[] = Object.freeze(['base', 'shadow', 'light']);
export const STYLE_KEYS: readonly (keyof SurfaceStyle)[] = Object.freeze([
  'contrast', 'wash', 'marks', 'quiet', 'relief', 'roughness',
  'roughnessVariation', 'metalness', 'clearcoat', 'opacity',
]);
const recipeKeys = ['version', 'mapping', 'style', 'palette'];
const normalized = new WeakMap<object, 'mapping' | 'style' | 'recipe'>();
const mappingDefaults: FacetMapping = {scale: .16, stretch: [1, 1, 1], rotation: -13, seed: 29031};
const styleDefaults: SurfaceStyle = {
  contrast: .58, wash: .48, marks: .48, quiet: .72, relief: .18,
  roughness: .82, roughnessVariation: .13, metalness: 0, clearcoat: .04, opacity: 1,
};
const literal = (hex: string): ColorExpression => ownValue({kind: 'color', value: srgbToLinear(hex)});
export const DEFAULT_PALETTE: PaintPalette = ownValue({
  base: literal('#617c89'), shadow: literal('#26394d'), light: literal('#b6c4b7'),
});

function record<T>(value: T, name: string, keys: readonly string[]): asserts value is T & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${name} must be a plain object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`Unknown ${name} property: ${key}.`);
}
function number(value: unknown, name: string, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
    throw new RangeError(`${name} must be finite and at least ${low}, at most ${high}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}
function publish<T extends object>(value: T, kind: 'mapping' | 'style' | 'recipe'): Readonly<T> {
  const result = ownFrozen(Object.freeze(value));
  normalized.set(result, kind);
  return result;
}

/** Normalize mapping independently of appearance. */
export function normalizeFacetMapping(input: unknown = {}): FacetMapping {
  if (typeof input === 'object' && input !== null && normalized.get(input) === 'mapping') return input as FacetMapping;
  record(input, 'facet mapping', FACET_KEYS);
  const value = {...mappingDefaults, ...input};
  const scale = number(value.scale, 'scale', .0001, 10000);
  if (!Array.isArray(value.stretch) || value.stretch.length !== 3) throw new TypeError('stretch must contain three positive numbers.');
  const stretch: Vec3 = ownValue([
    number(value.stretch[0], 'stretch[0]', .0001, 10000),
    number(value.stretch[1], 'stretch[1]', .0001, 10000),
    number(value.stretch[2], 'stretch[2]', .0001, 10000),
  ]);
  const rotation = number(value.rotation, 'rotation', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const seed = number(value.seed, 'seed', 0, 0xffffffff);
  if (!Number.isInteger(seed)) throw new RangeError('seed must be a uint32 integer.');
  return publish({scale, stretch, rotation: ((rotation % 360) + 360) % 360, seed}, 'mapping');
}

/** Styles contain numeric appearance controls; color is always a graph input. */
export function normalizePaintStyle(input: unknown = {}): SurfaceStyle {
  if (typeof input === 'string') return normalizeSurfaceRecipe(input).style;
  if (typeof input === 'object' && input !== null && normalized.get(input) === 'style') return input as SurfaceStyle;
  record(input, 'paint style', STYLE_KEYS);
  return publish(Object.fromEntries(STYLE_KEYS.map(key => [key,
    number(Object.hasOwn(input, key) ? input[key] : styleDefaults[key], key, 0, 1)])) as unknown as SurfaceStyle, 'style');
}

/** Persistent numeric edit: unchanged styles keep their identity. */
export function patchPaintStyle(current: unknown, patch: unknown): SurfaceStyle {
  const style = normalizePaintStyle(current);
  if (patch === style) return style;
  record(patch, 'paint style patch', STYLE_KEYS);
  let result: SurfaceStyle = style;
  for (const key of Object.keys(patch) as (keyof SurfaceStyle)[]) {
    const value = number(patch[key], key, 0, 1);
    if (value !== style[key]) result = {...result, [key]: value};
  }
  return result === style ? style : publish(result, 'style');
}

/** Merge once at authoring, then own all palette roots together. */
export function normalizePaintPalette(input: PaintPalettePatch = {}, defaults: PaintPalette = DEFAULT_PALETTE): PaintPalette {
  record(input, 'paint palette', PALETTE_KEYS);
  const palette = {...defaults, ...input};
  for (const key of PALETTE_KEYS) {
    const value = palette[key];
    if (!value || typeof value !== 'object' || !('kind' in value)) throw new TypeError(`palette.${key} must be a color expression.`);
  }
  if (PALETTE_KEYS.every(key => palette[key] === defaults[key])) return defaults;
  if (PALETTE_KEYS.every(key => Object.hasOwn(input, key)) && isOwned(input)) return input as PaintPalette;
  return ownValue(palette);
}

function recipeFromParts(mapping: FacetMapping, style: SurfaceStyle, palette: PaintPalette): SurfaceRecipe {
  return publish({version: SURFACE_RECIPE_VERSION, mapping, style, palette}, 'recipe');
}
function makeRecipe(input: unknown): SurfaceRecipe {
  record(input, 'recipe', recipeKeys);
  if (Object.hasOwn(input, 'version') && input.version !== SURFACE_RECIPE_VERSION) throw new RangeError('Unsupported Moonweave surface recipe version.');
  return recipeFromParts(normalizeFacetMapping(input.mapping), normalizePaintStyle(input.style),
    normalizePaintPalette(input.palette as PaintPalettePatch | undefined));
}

// Compact source data is decoded once. Presets expose the same expression form as authored colors.
type PresetSeed = Partial<FacetMapping & SurfaceStyle> & {palette?: Readonly<Record<PaletteRole, string>>};
function preset(label: string, description: string, seed: PresetSeed) {
  const mapping = Object.fromEntries(FACET_KEYS.filter(key => Object.hasOwn(seed, key)).map(key => [key, seed[key]]));
  const style = Object.fromEntries(STYLE_KEYS.filter(key => Object.hasOwn(seed, key)).map(key => [key, seed[key]]));
  const palette = seed.palette ? Object.fromEntries(PALETTE_KEYS.map(key => [key, literal(seed.palette![key])])) as PaintPalette : DEFAULT_PALETTE;
  return Object.freeze({label, description, recipe: recipeFromParts(normalizeFacetMapping(mapping), normalizePaintStyle(style), ownValue(palette))});
}

export const SURFACE_PRESETS = Object.freeze({
  moonstone: preset('Moonstone', 'Quiet blue slate, filled angular planes and soft mineral pigment.', {}),
  carapace: preset('Carapace', 'Deep blue armour with restrained ivory planes and satin edges.', {
    palette: {base: '#456b83', shadow: '#1d2b45', light: '#d4d9c2'},
    scale: 0.14, stretch: [1, 1.4, 1], contrast: 0.72, marks: 0.61,
    relief: 0.22, roughness: 0.55, clearcoat: 0.24,
  }),
  horn: preset('Horn', 'Warm ivory with long, directional ochre strokes.', {
    palette: {base: '#c1b397', shadow: '#74614f', light: '#ece3c7'},
    scale: 0.12, stretch: [0.65, 2.8, 0.65], rotation: 8,
    contrast: 0.48, marks: 0.38, relief: 0.15, roughness: 0.64, clearcoat: 0.1,
  }),
  membrane: preset('Membrane', 'Plum and iris washes with elongated, lightly painted folds.', {
    palette: {base: '#74628e', shadow: '#342a51', light: '#c4b4d9'},
    scale: 0.21, stretch: [1.8, 1, 0.8], contrast: 0.42, wash: 0.68,
    marks: 0.25, quiet: 0.85, relief: 0.07, roughness: 0.56, clearcoat: 0.17,
  }),
  velvet: preset('Velvet', 'Blue moss pigment, broad quiet areas and very shallow relief.', {
    palette: {base: '#527a79', shadow: '#293e53', light: '#a9ba9b'},
    scale: 0.23, contrast: 0.42, wash: 0.65, marks: 0.32,
    quiet: 0.86, relief: 0.06, roughness: 0.96, clearcoat: 0,
  }),
  obsidian: preset('Obsidian', 'Violet charcoal with sparse silver facets.', {
    palette: {base: '#37384c', shadow: '#161d2c', light: '#8b8ea8'},
    scale: 0.18, contrast: 0.65, wash: 0.32, marks: 0.47,
    quiet: 0.82, relief: 0.12, roughness: 0.42, metalness: 0.12, clearcoat: 0.32,
  }),
});

/** Normalize a preset or a v2 recipe. Legacy documents use migrateSurfaceRecipe. */
export function normalizeSurfaceRecipe(input: unknown = 'moonstone'): SurfaceRecipe {
  if (typeof input === 'string') {
    if (!Object.hasOwn(SURFACE_PRESETS, input)) throw new RangeError(`Unknown Moonweave preset: ${input}.`);
    return SURFACE_PRESETS[input as SurfacePreset].recipe;
  }
  return typeof input === 'object' && input !== null && normalized.get(input) === 'recipe'
    ? input as SurfaceRecipe : makeRecipe(input);
}

/** Mapping, style and palette are independent parts of the same canonical recipe. */
export function splitRecipe(input: unknown = 'moonstone'): SurfaceRecipe { return normalizeSurfaceRecipe(input); }

export function patchSurfaceRecipe(current: unknown, patch: SurfacePreset | SurfacePatch): SurfaceRecipe {
  if (typeof patch === 'string') return normalizeSurfaceRecipe(patch);
  record(patch, 'recipe', recipeKeys);
  if (Object.hasOwn(patch, 'version') && patch.version !== SURFACE_RECIPE_VERSION) throw new RangeError('Unsupported Moonweave surface recipe version.');
  const recipe = normalizeSurfaceRecipe(current);
  if (patch === recipe) return recipe;
  let mapping = recipe.mapping;
  if (patch.mapping !== undefined) {
    record(patch.mapping, 'facet mapping patch', FACET_KEYS);
    const candidate = normalizeFacetMapping({...mapping, ...patch.mapping});
    if (candidate.scale !== mapping.scale || candidate.rotation !== mapping.rotation || candidate.seed !== mapping.seed
        || candidate.stretch.some((value, index) => value !== mapping.stretch[index])) mapping = candidate;
  }
  const style = patch.style === undefined ? recipe.style : patchPaintStyle(recipe.style, patch.style);
  const palette = patch.palette === undefined ? recipe.palette : normalizePaintPalette(patch.palette, recipe.palette);
  return mapping === recipe.mapping && style === recipe.style && palette === recipe.palette
    ? recipe : recipeFromParts(mapping, style, palette);
}

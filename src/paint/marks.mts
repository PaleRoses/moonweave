import {CHANNELS, finite, freeze, record, reference} from '../core/algebra.mts';
import type {Channel, ImageFilter, ImageResource, Vec3} from '../core/algebra.mts';
import {IMAGE_LIMITS, normalizeImage} from '../core/resources.mts';
import {ownFrozen} from '../core/ownership.mts';

export type MarkPoint = readonly [number, number];
/** Forward affine map: x'=a*x+c*y+e, y'=b*x+d*y+f. */
export type MarkTransform = readonly [number, number, number, number, number, number];
export type MarkBounds = readonly [number, number, number, number];
export interface MarkBrushInput {readonly mask: ImageResource; readonly filter?: ImageFilter}
export interface MarkBrush {readonly mask: ImageResource; readonly filter: ImageFilter}
export interface MarkZoneInput extends MarkBrushInput {readonly transform?: MarkTransform}
export interface MarkZone extends MarkBrush {readonly transform: MarkTransform}

interface MarkStyleInput {
  readonly brush: string;
  /** Linear Rec.709 reflectance, in [0,1]. Gamut-map tagged colors explicitly before deposition. */
  readonly color: Vec3;
  /** Dab coverage strength, separate from the material opacity target. */
  readonly opacity?: number;
  /** Additive thickness/depth, multiplied by the dab's covered area before baking. */
  readonly height?: number;
  readonly channels?: Partial<Readonly<Record<Channel, number>>>;
  readonly zone?: string;
}
interface MarkStyle extends Omit<MarkStyleInput, 'opacity' | 'height' | 'channels'> {
  readonly opacity: number;
  readonly height: number;
  readonly channels: Partial<Readonly<Record<Channel, number>>>;
}
export interface DabMarkInput extends MarkStyleInput {readonly kind: 'dab'; readonly transform: MarkTransform}
export interface DabMark extends MarkStyle {readonly kind: 'dab'; readonly transform: MarkTransform}
export interface StrokePointInput {readonly at: MarkPoint; readonly pressure?: number}
export interface StrokePoint {readonly at: MarkPoint; readonly pressure: number}
export interface StrokeMarkInput extends MarkStyleInput {
  readonly kind: 'stroke';
  readonly points: readonly StrokePointInput[];
  /** Base radius in path units. Pressure scales both radius and dab opacity. */
  readonly radius: number;
  /** Distance between dabs, in base-radius units; independent of vertex density. */
  readonly spacing?: number;
  /** Radius perpendicular to the direction, divided by the along-path radius. */
  readonly aspect?: number;
  /** Counterclockwise degrees, added to the path direction when align is path. */
  readonly angle?: number;
  readonly align?: 'path' | 'fixed';
  readonly transform?: MarkTransform;
}
export interface StrokeMark extends MarkStyle {
  readonly kind: 'stroke';
  readonly points: readonly StrokePoint[];
  readonly radius: number;
  readonly spacing: number;
  readonly aspect: number;
  readonly angle: number;
  readonly align: 'path' | 'fixed';
  readonly transform: MarkTransform;
}
export type MarkInput = DabMarkInput | StrokeMarkInput;
export type Mark = DabMark | StrokeMark;
export interface MarkProgramInput {
  readonly version?: 1;
  readonly brushes: Readonly<Record<string, MarkBrushInput>>;
  readonly zones?: Readonly<Record<string, MarkZoneInput>>;
  readonly marks: readonly MarkInput[];
}
export interface MarkProgram {
  readonly version: 1;
  readonly brushes: Readonly<Record<string, MarkBrush>>;
  readonly zones: Readonly<Record<string, MarkZone>>;
  readonly marks: readonly Mark[];
}

export const MARK_LIMITS = Object.freeze({
  marks: 16384, points: 65536, dabs: 65536, resources: 256,
  imageComponents: IMAGE_LIMITS.components, jsonBytes: 16777216, samples: 8,
});
export const IDENTITY_MARK_TRANSFORM: MarkTransform = Object.freeze([1, 0, 0, 1, 0, 0]);

// A validation proof, not a store of derived state. Frozen caller values still
// cross the ordinary boundary; only programs constructed here can be borrowed.
const programs = new WeakSet<object>();

export function markUnit(value: unknown, name: string): number {
  const result = finite(value, name);
  if (result < 0 || result > 1) throw new RangeError(`${name} must be in [0,1].`);
  return result;
}

export function markPoint(value: unknown, name: string): MarkPoint {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${name} requires two coordinates.`);
  return [finite(value[0], name), finite(value[1], name)];
}

export function markTransform(value: unknown, name: string): MarkTransform {
  if (!Array.isArray(value) || value.length !== 6) throw new TypeError(`${name} requires six affine coefficients.`);
  const a = Array.from(value, v => finite(v, name)) as unknown as MarkTransform;
  inverseMarkTransform(a, name);
  return a;
}

/** Shared inverse contract for authored transforms and expanded dab placements. */
export function inverseMarkTransform(m: MarkTransform, name: string): MarkTransform {
  const determinant = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(determinant) || determinant === 0) throw new RangeError(`${name} must be invertible.`);
  const a = m[3] / determinant, b = -m[1] / determinant, c = -m[2] / determinant, d = m[0] / determinant;
  return [a, b, c, d, -a * m[4] - c * m[5], -b * m[4] - d * m[5]]
    .map(value => finite(value, `${name} inverse`)) as unknown as MarkTransform;
}

const positive = (value: unknown, name: string) => {
  const result = finite(value, name);
  if (result <= 0) throw new RangeError(`${name} must be positive.`);
  return result;
};
const styleKeys = ['brush', 'color', 'opacity', 'height', 'channels', 'zone'];

/**
 * Own a portable mark program. Resources and affine placements are data, never
 * callbacks. A single local ownership map preserves raw mask sharing across
 * brushes and zones; no persistent authoring cache or mutable drawing graph.
 */
export function markProgram(input: MarkProgramInput): MarkProgram {
  if (programs.has(input)) return input as MarkProgram;
  record(input, 'mark program', ['version', 'brushes', 'zones', 'marks']);
  if (input.version !== undefined && input.version !== 1) throw new RangeError('Unsupported mark program version.');
  record(input.brushes, 'mark brushes');
  record(input.zones ?? {}, 'mark zones');
  if (!Array.isArray(input.marks) || input.marks.length > MARK_LIMITS.marks) throw new RangeError(`Mark programs allow at most ${MARK_LIMITS.marks} marks.`);
  const resources = new Map<ImageResource, ImageResource>();
  let components = 0, points = 0;
  const mask = (raw: ImageResource) => {
    let owned = resources.get(raw);
    if (owned) return owned;
    owned = normalizeImage(raw);
    if (owned.channels !== 1) throw new TypeError('Brush and zone masks require one scalar channel.');
    for (const value of owned.data) markUnit(value, 'mask coverage');
    resources.set(raw, owned);
    components += owned.data.length;
    if (resources.size > MARK_LIMITS.resources || components > MARK_LIMITS.imageComponents) throw new RangeError('Mark resources exceed the program image budget.');
    return owned;
  };
  const brush = (raw: MarkBrushInput): MarkBrush => {
    const filter = raw.filter ?? 'anisotropic';
    if (!['linear', 'trilinear', 'anisotropic'].includes(filter)) throw new TypeError('Invalid mark image filter.');
    return {mask: mask(raw.mask), filter};
  };
  const brushes: Record<string, MarkBrush> = Object.create(null);
  for (const [name, value] of Object.entries(input.brushes)) {
    reference(name, 'brush name'); record(value, 'brush', ['mask', 'filter']);
    brushes[name] = brush(value);
  }
  const zones: Record<string, MarkZone> = Object.create(null);
  for (const [name, value] of Object.entries(input.zones ?? {})) {
    reference(name, 'zone name'); record(value, 'mark zone', ['mask', 'filter', 'transform']);
    zones[name] = {...brush(value), transform: markTransform(value.transform ?? IDENTITY_MARK_TRANSFORM, 'zone transform')};
  }
  const marks = Array.from(input.marks, (raw): Mark => {
    const keys = raw?.kind === 'dab' ? ['kind', ...styleKeys, 'transform']
      : ['kind', ...styleKeys, 'points', 'radius', 'spacing', 'aspect', 'angle', 'align', 'transform'];
    record(raw, 'mark', keys);
    const brush = reference(raw.brush, 'mark brush');
    if (!Object.hasOwn(brushes, brush)) throw new RangeError(`Unknown mark brush: ${brush}.`);
    const zone = raw.zone === undefined ? undefined : reference(raw.zone, 'mark zone');
    if (zone !== undefined && !Object.hasOwn(zones, zone)) throw new RangeError(`Unknown mark zone: ${zone}.`);
    if (!Array.isArray(raw.color) || raw.color.length !== 3) throw new TypeError('Mark color requires linear Rec709 reflectance RGB.');
    const color = Array.from(raw.color, (v: unknown) => markUnit(v, 'mark pigment; gamut-map extended colors explicitly')) as unknown as Vec3;
    const channels: Partial<Record<Channel, number>> = {};
    record(raw.channels ?? {}, 'mark channels', CHANNELS);
    for (const channel of CHANNELS) if (raw.channels?.[channel] !== undefined) channels[channel] = markUnit(raw.channels[channel], `mark ${channel}`);
    const style: MarkStyle = {brush, color, opacity: markUnit(raw.opacity ?? 1, 'mark opacity'),
      height: finite(raw.height ?? 0, 'mark height'), channels, ...(zone === undefined ? {} : {zone})};
    if (raw.kind === 'dab') return {...style, kind: 'dab', transform: markTransform(raw.transform, 'dab transform')};
    if (raw.kind !== 'stroke') throw new TypeError('Mark kind must be dab or stroke.');
    if (!Array.isArray(raw.points) || raw.points.length === 0 || (points += raw.points.length) > MARK_LIMITS.points) throw new RangeError(`Stroke points require a nonempty path within the ${MARK_LIMITS.points}-point program budget.`);
    const path = Array.from(raw.points, (point: unknown) => {
      record(point, 'stroke point', ['at', 'pressure']);
      return {at: markPoint(point.at, 'stroke point'), pressure: markUnit(point.pressure ?? 1, 'stroke pressure')};
    });
    const align = raw.align ?? 'path';
    if (align !== 'path' && align !== 'fixed') throw new TypeError('Stroke align must be path or fixed.');
    return {...style, kind: 'stroke', points: path, radius: positive(raw.radius, 'stroke radius'),
      spacing: positive(raw.spacing ?? .35, 'stroke spacing'), aspect: positive(raw.aspect ?? 1, 'stroke aspect'),
      angle: finite(raw.angle ?? 0, 'stroke angle'), align,
      transform: markTransform(raw.transform ?? IDENTITY_MARK_TRANSFORM, 'stroke transform')};
  });
  const program = ownFrozen(freeze({version: 1 as const, brushes, zones, marks}));
  programs.add(program);
  return program;
}

/** JSON stores paths and source resources, never expanded dabs or spatial bins. */
export function serializeMarkProgram(input: MarkProgramInput): string {
  const program = markProgram(input), images: ImageResource[] = [];
  const indices = new Map<ImageResource, number>();
  const index = (mask: ImageResource) => {
    let id = indices.get(mask);
    if (id === undefined) {id = images.length; images.push(mask); indices.set(mask, id);}
    return id;
  };
  const brushes = Object.fromEntries(Object.entries(program.brushes).map(([name, brush]) =>
    [name, {image: index(brush.mask), filter: brush.filter}]));
  const zones = Object.fromEntries(Object.entries(program.zones).map(([name, zone]) =>
    [name, {image: index(zone.mask), filter: zone.filter, transform: zone.transform}]));
  const text = JSON.stringify({version: 1, images, brushes, zones, marks: program.marks}) + '\n';
  if (new TextEncoder().encode(text).length > MARK_LIMITS.jsonBytes) throw new RangeError('Mark program JSON exceeds the size budget.');
  return text;
}

export function parseMarkProgram(text: string): MarkProgram {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MARK_LIMITS.jsonBytes) throw new RangeError('Mark program JSON exceeds the size budget.');
  const input: unknown = JSON.parse(text);
  record(input, 'mark program', ['version', 'images', 'brushes', 'zones', 'marks']);
  if (input.version !== 1) throw new RangeError('Unsupported mark program version.');
  if (!Array.isArray(input.images) || input.images.length > MARK_LIMITS.resources) throw new RangeError('Mark program requires a bounded image table.');
  record(input.brushes, 'mark brushes'); record(input.zones, 'mark zones');
  const images: readonly unknown[] = input.images, used = new Set<number>();
  const resolve = (id: unknown): ImageResource => {
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= images.length) throw new RangeError('Invalid mark image reference.');
    used.add(id); return images[id] as ImageResource;
  };
  const brushes = Object.fromEntries(Object.entries(input.brushes).map(([name, brush]) => {
    record(brush, 'serialized brush', ['image', 'filter']);
    return [name, {mask: resolve(brush.image), filter: brush.filter as ImageFilter}];
  }));
  const zones = Object.fromEntries(Object.entries(input.zones).map(([name, zone]) => {
    record(zone, 'serialized zone', ['image', 'filter', 'transform']);
    return [name, {mask: resolve(zone.image), filter: zone.filter as ImageFilter, transform: zone.transform as MarkTransform}];
  }));
  if (used.size !== images.length) throw new RangeError('Mark image table contains unreferenced resources.');
  return markProgram({version: 1, brushes, zones, marks: input.marks as readonly MarkInput[]});
}

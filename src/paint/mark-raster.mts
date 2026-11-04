import {CHANNELS, finite, freeze, record} from '../core/algebra.mts';
import type {Channel, ImageResource, Vec3} from '../core/algebra.mts';
import {IMAGE_LIMITS, normalizeImage} from '../core/resources.mts';
import {imageFilterPlan, prepareImageSampler} from '../core/image-filter.mts';
import type {ImageFootprint} from '../core/image-filter.mts';
import {hueRadians} from '../core/color.mts';
import {MARK_LIMITS, inverseMarkTransform, markProgram} from './marks.mts';
import type {Mark, MarkBounds, MarkBrush, MarkPoint, MarkProgram, MarkProgramInput, MarkTransform, StrokeMark} from './marks.mts';

export interface MarkBakeOptions {
  readonly width: number;
  readonly height: number;
  /** Finite object-plane rectangle [minimumX, minimumY, maximumX, maximumY]. */
  readonly bounds?: MarkBounds;
  /** Stratified samples along each texel axis, 1–8. Defaults to 2 (four samples). */
  readonly samples?: number;
}
export interface MarkBakeStats {
  readonly dabs: number;
  readonly tiles: number;
  readonly tileReferences: number;
  /** Candidate dab tests after spatial binning, across all quadrature samples. */
  readonly dabTests: number;
  /** Filtered zone evaluations; each touched zone is sampled once per quadrature point. */
  readonly zoneSamples: number;
  readonly samples: number;
}
export interface MarkBake {
  readonly bounds: MarkBounds;
  /** Associated (premultiplied) linear Rec709 pigment, filtered before deposition. */
  readonly pigment: ImageResource;
  readonly coverage: ImageResource;
  /** Associated roughness, metalness, clearcoat targets, in that order. */
  readonly finishValues: ImageResource;
  /** Their independent coverages. An omitted channel never covers the underlying finish. */
  readonly finishCoverage: ImageResource;
  /** R: associated material opacity; G: opacity coverage; B: additive covered height. */
  readonly opacityHeight: ImageResource;
  readonly channels: readonly Channel[];
  readonly hasHeight: boolean;
  readonly stats: MarkBakeStats;
}
export interface CompiledMarkProgram {
  readonly program: MarkProgram;
  readonly dabCount: number;
  /** Reuses path expansion; each bake plans its own fixed footprints and spatial bins. */
  readonly bake: (options: MarkBakeOptions) => MarkBake;
}

interface Placement {readonly brush: MarkBrush; readonly transform: MarkTransform; readonly inverse: MarkTransform}
interface Dab extends Placement {readonly style: Mark; readonly opacity: number; readonly zone: number}
interface PreparedMask {readonly sample: (point: MarkPoint) => number; readonly bounds: MarkBounds}
interface PreparedDab extends PreparedMask {readonly dab: Dab}
type BakeEffects = Pick<MarkBake, 'channels' | 'hasHeight'>;
const TILE_SIZE = 16;

const intersectBounds = (a: MarkBounds, b: MarkBounds): MarkBounds =>
  [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

function compose(a: MarkTransform, b: MarkTransform): MarkTransform {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
const point = (m: MarkTransform, p: MarkPoint): MarkPoint => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const vector = (m: MarkTransform, p: MarkPoint): MarkPoint => [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1]];

function strokeDabs(mark: StrokeMark, remaining: number, emit: (transform: MarkTransform, pressure: number) => void): number {
  if (mark.points.every(point => point.pressure === 0)) return 0;
  const segments: {start: number; end: number; index: number; angle: number}[] = [];
  let length = 0, correction = 0;
  for (let i = 1; i < mark.points.length; i++) {
    const a = mark.points[i - 1].at, b = mark.points[i].at;
    const dx = b[0] - a[0], dy = b[1] - a[1], distance = Math.hypot(dx, dy);
    if (distance > 0) {
      const corrected = distance - correction, end = length + corrected;
      correction = (end - length) - corrected;
      segments.push({start: length, end, index: i, angle: Math.atan2(dy, dx)}); length = end;
    }
  }
  const step = mark.radius * mark.spacing;
  if (!Number.isFinite(step) || step <= 0) throw new RangeError('Stroke spacing is not representable.');
  let count = Math.ceil(length / step);
  // A collinear subdivision can perturb length by a few ULPs. Do not turn that
  // rounding into an additional nearly coincident endpoint deposit.
  if (count > 1 && length - (count - 1) * step <= 16 * Number.EPSILON * length) count--;
  if (!Number.isFinite(count) || count + 1 > remaining) throw new RangeError('Stroke exceeds the expanded dab budget.');
  let segmentIndex = 0;
  for (let i = 0; i <= count; i++) {
    const distance = i === count ? length : i * step;
    while (segmentIndex + 1 < segments.length && distance > segments[segmentIndex].end) segmentIndex++;
    const segment = segments[segmentIndex];
    const a = segment ? mark.points[segment.index - 1] : mark.points[mark.points.length - 1];
    const b = segment ? mark.points[segment.index] : a;
    const t = segment ? (distance - segment.start) / (segment.end - segment.start) : 0;
    const pressure = i === count ? mark.points[mark.points.length - 1].pressure : a.pressure + (b.pressure - a.pressure) * t;
    if (pressure <= 0) continue;
    const x = a.at[0] + (b.at[0] - a.at[0]) * t, y = a.at[1] + (b.at[1] - a.at[1]) * t;
    const angle = hueRadians(mark.angle) + (mark.align === 'path' ? segment?.angle ?? 0 : 0);
    const c = Math.cos(angle), s = Math.sin(angle), radius = mark.radius * pressure;
    const aa = 2 * radius * c, ab = 2 * radius * s, ac = -2 * radius * mark.aspect * s, ad = 2 * radius * mark.aspect * c;
    emit(compose(mark.transform, [aa, ab, ac, ad, x - (aa + ac) / 2, y - (ab + ad) / 2]), pressure);
  }
  return count + 1;
}

function prepareMask(placement: Placement, footprint: ImageFootprint): PreparedMask {
  const {brush, transform: m, inverse: pullback} = placement;
  const local: ImageFootprint = {dx: vector(pullback, footprint.dx), dy: vector(pullback, footprint.dy)};
  const plan = imageFilterPlan(brush.mask, local, brush.filter, 'zero');
  const sample = prepareImageSampler(brush.mask, 'zero', brush.filter, local);
  // Bounds include bilinear support, both mip levels, virtual coarse levels,
  // and every anisotropic tap. Culling therefore retains filtered subpixel dabs.
  const level = Math.ceil(plan.lod), halfTaps = (plan.taps - 1) / 2;
  const extent = ([brush.mask.width, brush.mask.height] as const).map((size, axis) => {
    const stored = Math.max(1, Math.floor(size / 2 ** level));
    const inverse = 2 ** Math.min(0, Math.log2(size) - level);
    return (.5 + .5 / stored) / inverse + halfTaps * Math.abs(plan.step[axis]);
  });
  const center = point(m, [.5, .5]);
  const x = Math.abs(m[0]) * extent[0] + Math.abs(m[2]) * extent[1];
  const y = Math.abs(m[1]) * extent[0] + Math.abs(m[3]) * extent[1];
  return {sample: position => sample(point(pullback, position)).value[0],
    bounds: [center[0] - x, center[1] - y, center[0] + x, center[1] + y]};
}

function bakeShape(options: MarkBakeOptions) {
  record(options, 'mark bake', ['width', 'height', 'bounds', 'samples']);
  const {width, height} = options, samples = options.samples ?? 2;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > IMAGE_LIMITS.dimension || height > IMAGE_LIMITS.dimension
      || width * height * 13 > MARK_LIMITS.imageComponents) throw new RangeError('Mark bake exceeds the shared 13-component image budget.');
  if (!Number.isInteger(samples) || samples < 1 || samples > MARK_LIMITS.samples) throw new RangeError(`Mark bake samples must be an integer in [1,${MARK_LIMITS.samples}].`);
  const raw = options.bounds ?? [0, 0, 1, 1];
  if (!Array.isArray(raw) || raw.length !== 4) throw new TypeError('Mark bake bounds require four coordinates.');
  const bounds = Array.from(raw, v => finite(v, 'mark bake bounds')) as unknown as MarkBounds;
  if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new RangeError('Mark bake bounds must have positive area.');
  return {width, height, samples, bounds};
}

function rasterize(dabs: readonly Dab[], zonePlacements: readonly Placement[], effects: BakeEffects, options: MarkBakeOptions): MarkBake {
  const {width, height, samples, bounds} = bakeShape(options);
  const pixelWidth = (bounds[2] - bounds[0]) / width, pixelHeight = (bounds[3] - bounds[1]) / height;
  const footprint: ImageFootprint = {dx: [pixelWidth / samples, 0], dy: [0, pixelHeight / samples]};
  const zones = zonePlacements.map(zone => prepareMask(zone, footprint));
  const prepared: PreparedDab[] = dabs.map(dab => {
    const mask = prepareMask(dab, footprint);
    // The support of brush × zone lies inside both filtered supports. Preserve
    // their sampling/order; only the conservative spatial candidate set changes.
    return {dab, sample: mask.sample, bounds: dab.zone === -1 ? mask.bounds
      : intersectBounds(mask.bounds, zones[dab.zone].bounds)};
  });
  const across = Math.ceil(width / TILE_SIZE), down = Math.ceil(height / TILE_SIZE);
  const tiles: number[][] = Array.from({length: across * down}, () => []);
  let tileReferences = 0;
  prepared.forEach((dab, index) => {
    if (dab.bounds[0] > dab.bounds[2] || dab.bounds[1] > dab.bounds[3]) return;
    const x0 = Math.max(0, Math.floor((dab.bounds[0] - bounds[0]) / pixelWidth / TILE_SIZE));
    const y0 = Math.max(0, Math.floor((dab.bounds[1] - bounds[1]) / pixelHeight / TILE_SIZE));
    const x1 = Math.min(across - 1, Math.floor((dab.bounds[2] - bounds[0]) / pixelWidth / TILE_SIZE));
    const y1 = Math.min(down - 1, Math.floor((dab.bounds[3] - bounds[1]) / pixelHeight / TILE_SIZE));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {tiles[y * across + x].push(index); tileReferences++;}
  });
  // Each bucket was filled in authored dab order. No per-pixel sorting or full
  // program scan occurs; coverage, pigment, finish and height are integrated
  // together at each quadrature sample before their texel averages are formed.
  const pixels = width * height;
  const pigment = new Array<number>(pixels * 3).fill(0), coverage = new Array<number>(pixels).fill(0);
  const finishValues = new Array<number>(pixels * 3).fill(0), finishCoverage = new Array<number>(pixels * 3).fill(0);
  const opacityHeight = new Array<number>(pixels * 3).fill(0);
  const state = new Array<number>(13).fill(0), sum = new Array<number>(13).fill(0);
  const zoneValues = new Float64Array(zones.length), zoneEpochs = new Uint32Array(zones.length);
  const sampleCount = samples * samples;
  // The image/component and sample budgets keep this epoch below 2^32. A new
  // sample invalidates prior values in O(1), independent of the total zone count.
  let epoch = 0, dabTests = 0, zoneSamples = 0;
  for (let tileY = 0; tileY < down; tileY++) for (let tileX = 0; tileX < across; tileX++) {
    const candidates = tiles[tileY * across + tileX];
    if (candidates.length === 0) continue;
    for (let y = tileY * TILE_SIZE; y < Math.min(height, (tileY + 1) * TILE_SIZE); y++) {
      for (let x = tileX * TILE_SIZE; x < Math.min(width, (tileX + 1) * TILE_SIZE); x++) {
        sum.fill(0);
        for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
          state.fill(0); epoch++;
          const position: MarkPoint = [bounds[0] + (x + (sx + .5) / samples) * pixelWidth,
            bounds[1] + (y + (sy + .5) / samples) * pixelHeight];
          for (const index of candidates) {
            dabTests++;
            const preparedDab = prepared[index], {dab} = preparedDab;
            if (position[0] < preparedDab.bounds[0] || position[0] > preparedDab.bounds[2]
                || position[1] < preparedDab.bounds[1] || position[1] > preparedDab.bounds[3]) continue;
            let a = preparedDab.sample(position) * dab.opacity;
            if (a === 0) continue;
            if (dab.zone !== -1) {
              if (zoneEpochs[dab.zone] !== epoch) {
                zoneValues[dab.zone] = zones[dab.zone].sample(position);
                zoneEpochs[dab.zone] = epoch; zoneSamples++;
              }
              a *= zoneValues[dab.zone];
            }
            const retain = 1 - a, {style} = dab;
            for (let channel = 0; channel < 3; channel++) state[channel] = style.color[channel] * a + retain * state[channel];
            state[3] = a + retain * state[3];
            for (let i = 0; i < CHANNELS.length; i++) {
              const target = style.channels[CHANNELS[i]];
              if (target === undefined) continue;
              const valueIndex = i === 3 ? 10 : 4 + i, maskIndex = i === 3 ? 11 : 7 + i;
              state[valueIndex] = target * a + retain * state[valueIndex];
              state[maskIndex] = a + retain * state[maskIndex];
            }
            state[12] += style.height * a;
          }
          for (let i = 0; i < state.length; i++) sum[i] += state[i];
        }
        const pixel = y * width + x;
        for (let i = 0; i < 3; i++) {
          pigment[pixel * 3 + i] = sum[i] / sampleCount;
          finishValues[pixel * 3 + i] = sum[i + 4] / sampleCount;
          finishCoverage[pixel * 3 + i] = sum[i + 7] / sampleCount;
          opacityHeight[pixel * 3 + i] = sum[i + 10] / sampleCount;
        }
        coverage[pixel] = sum[3] / sampleCount;
      }
    }
  }
  const image = (data: number[], channels: 1 | 3) => normalizeImage({width, height, channels, data});
  return freeze({bounds, pigment: image(pigment, 3), coverage: image(coverage, 1), finishValues: image(finishValues, 3),
    finishCoverage: image(finishCoverage, 3), opacityHeight: image(opacityHeight, 3),
    ...effects,
    stats: {dabs: dabs.length, tiles: tiles.length, tileReferences, dabTests, zoneSamples, samples: pixels * sampleCount}});
}

/** Expand deterministic, distance-spaced paths once; retain only this explicit owner. */
export function compileMarkProgram(input: MarkProgramInput): CompiledMarkProgram {
  const program = markProgram(input), zones: Placement[] = [], zoneIndices = new Map<string, number>();
  // Authoring can retain alternate zones. Only emitted dabs retain placements,
  // so unused masks need no filtering plan or per-sample scratch slot.
  const zoneIndex = (name: string | undefined): number => {
    if (name === undefined) return -1;
    let index = zoneIndices.get(name);
    if (index === undefined) {
      const zone = program.zones[name];
      index = zones.length; zoneIndices.set(name, index);
      zones.push({brush: zone, transform: zone.transform, inverse: inverseMarkTransform(zone.transform, 'zone transform')});
    }
    return index;
  };
  const dabs: Dab[] = [];
  const channels = new Set<Channel>();
  let hasHeight = false;
  let expanded = 0;
  for (const style of program.marks) {
    if (style.opacity === 0) continue;
    const before = dabs.length;
    const emit = (transform: MarkTransform, pressure: number) => {
      const opacity = style.opacity * pressure;
      if (opacity === 0) return;
      if (dabs.length >= MARK_LIMITS.dabs) throw new RangeError('Mark program exceeds the expanded dab budget.');
      dabs.push({style, transform, inverse: inverseMarkTransform(transform, 'expanded mark placement'), brush: program.brushes[style.brush],
        opacity, zone: zoneIndex(style.zone)});
    };
    if (style.kind === 'dab') {
      if (expanded >= MARK_LIMITS.dabs) throw new RangeError('Mark program exceeds the expanded dab budget.');
      emit(style.transform, 1); expanded++;
    }
    else expanded += strokeDabs(style, MARK_LIMITS.dabs - expanded, emit);
    if (dabs.length !== before) {
      for (const channel of CHANNELS) if (style.channels[channel] !== undefined) channels.add(channel);
      hasHeight ||= style.height !== 0;
    }
  }
  const effects: BakeEffects = Object.freeze({channels: Object.freeze(CHANNELS.filter(channel => channels.has(channel))), hasHeight});
  return Object.freeze({program, dabCount: dabs.length, bake: (options: MarkBakeOptions) => rasterize(dabs, zones, effects, options)});
}

/** Convenience authoring boundary; repeated resolutions can reuse compileMarkProgram. */
export function bakeMarks(program: MarkProgramInput, options: MarkBakeOptions): MarkBake {
  return compileMarkProgram(program).bake(options);
}

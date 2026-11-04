import type {ImageResource, ImageAddress, ImageFilter} from './algebra.mts';
import type {ImageSample} from './resources.mts';

export interface ImageFootprint {readonly dx: readonly [number, number]; readonly dy: readonly [number, number]}
export interface ImageFilterPlan {readonly lod: number; readonly taps: number; readonly step: readonly [number, number]}

import {normalizeImage, sampleImage} from './resources.mts';

/** Bounded line integration, independent of driver anisotropy extensions. */
export const MAX_IMAGE_ANISOTROPY = 8;
/** Tap quantization convention at integer ratios, including numeric isotropy. */
export const IMAGE_TAP_EPSILON = 1e-6;
const pyramids = new WeakMap<ImageResource, readonly ImageResource[]>();

function overlaps(source: number, target: number) {
  const scale = source / target;
  return Array.from({length: target}, (_, i) => {
    const begin = i * scale, end = Math.min(source, (i + 1) * scale);
    const result: [number, number][] = [];
    for (let j = Math.floor(begin); j < Math.ceil(end); j++) {
      const weight = Math.min(end, j + 1) - Math.max(begin, j);
      if (weight > 0) result.push([j, weight / scale]);
    }
    return result;
  });
}

/**
 * Shared, derived mip data, never duplicated into graph JSON. Each destination
 * texel averages the source cells overlapping its normalized rectangle. Odd
 * dimensions therefore retain every source row and column. Positive normalized
 * weights preserve bounds and the image mean up to float32 rounding.
 */
export function imagePyramid(resource: ImageResource): readonly ImageResource[] {
  const image = normalizeImage(resource);
  const cached = pyramids.get(image);
  if (cached) return cached;
  const levels = [image];
  let source = image;
  while (source.width > 1 || source.height > 1) {
    const width = Math.max(1, Math.floor(source.width / 2));
    const height = Math.max(1, Math.floor(source.height / 2));
    const {channels} = source, data = new Array<number>(width * height * channels);
    const xs = overlaps(source.width, width), ys = overlaps(source.height, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < channels; channel++) {
        let sum = 0, total = 0, low = Infinity, high = -Infinity;
        for (const [sy, wy] of ys[y]) for (const [sx, wx] of xs[x]) {
          const weight = wx * wy;
          const value = source.data[(sy * source.width + sx) * channels + channel];
          sum += weight * value;
          total += weight;
          low = Math.min(low, value); high = Math.max(high, value);
        }
        // Retain the convex-average bound at float32's extreme finite values.
        data[(y * width + x) * channels + channel] = Math.max(low, Math.min(high, sum / total));
      }
    }
    source = normalizeImage({width, height, channels, data});
    levels.push(source);
  }
  Object.freeze(levels);
  pyramids.set(image, levels);
  return levels;
}

const pointPlan = (): ImageFilterPlan => ({lod: 0, taps: 1, step: [0, 0]});

/**
 * A pixel footprint is a UV Jacobian, independent of evaluation directions.
 * Its principal axes come from J Jᵀ in texel coordinates. Two normalization
 * stages and logarithmic lengths avoid overflow for finite, very large frames.
 * A one-texel clamp/repeat axis is constant; a zero-extended axis still has edges.
 */
export function imageFilterPlan(image: ImageResource, footprint?: ImageFootprint, filter: ImageFilter = 'trilinear', address: ImageAddress = 'clamp'): ImageFilterPlan {
  if (filter === 'linear' || !footprint) return pointPlan();
  const active = [image.width > 1 || address === 'zero', image.height > 1 || address === 'zero'];
  const x = footprint.dx.map((v, i) => active[i] ? v : 0);
  const y = footprint.dy.map((v, i) => active[i] ? v : 0);
  const uvScale = Math.max(Math.abs(x[0]), Math.abs(x[1]), Math.abs(y[0]), Math.abs(y[1]));
  if (uvScale === 0) return pointPlan();
  const size = [image.width, image.height];
  const nx = x.map((v, i) => v / uvScale * size[i]);
  const ny = y.map((v, i) => v / uvScale * size[i]);
  const texelScale = Math.max(Math.abs(nx[0]), Math.abs(nx[1]), Math.abs(ny[0]), Math.abs(ny[1]));
  for (let i = 0; i < 2; i++) { nx[i] /= texelScale; ny[i] /= texelScale; }
  const a = nx[0] * nx[0] + ny[0] * ny[0];
  const b = nx[0] * nx[1] + ny[0] * ny[1];
  const c = nx[1] * nx[1] + ny[1] * ny[1];
  const lambda = .5 * (a + c + Math.hypot(a - c, 2 * b));
  const root = Math.sqrt(lambda);
  const logScale = Math.log2(uvScale) + Math.log2(texelScale);
  const logMajor = logScale + Math.log2(root);
  if (logMajor <= 0) return pointPlan();
  const last = Math.floor(Math.log2(Math.max(image.width, image.height)));
  const cap = (lod: number) => address === 'zero' ? lod : Math.min(lod, last);
  if (filter === 'trilinear') return {lod: cap(logMajor), taps: 1, step: [0, 0]};

  const determinant = Math.abs(nx[0] * ny[1] - nx[1] * ny[0]);
  const logMinor = determinant === 0 ? -Infinity : logScale + Math.log2(determinant) - Math.log2(root);
  const logWidth = Math.max(0, logMinor, logMajor - Math.log2(MAX_IMAGE_ANISOTROPY));
  const taps = Math.min(MAX_IMAGE_ANISOTROPY,
    Math.max(1, Math.ceil(2 ** (logMajor - logWidth) - IMAGE_TAP_EPSILON)));
  if (taps === 1) return {lod: cap(logWidth), taps, step: [0, 0]};
  const axis = a >= c ? [lambda - c, b] : [b, lambda - a];
  const length = Math.hypot(axis[0], axis[1]);
  if (length === 0) { axis[0] = 1; axis[1] = 0; }
  else { axis[0] /= length; axis[1] /= length; }
  // The right singular vector reconstructs the major direction in UV without
  // materializing its potentially overflowing texel-space length.
  const rightX = (nx[0] * axis[0] + nx[1] * axis[1]) / root;
  const rightY = (ny[0] * axis[0] + ny[1] * axis[1]) / root;
  const step: [number, number] = [x[0] / taps * rightX + y[0] / taps * rightY, x[1] / taps * rightX + y[1] / taps * rightY];
  return {lod: cap(logWidth), taps, step};
}

/**
 * Zero-extended images continue beyond stored mip levels as a normalized
 * scale-space. A collapsed axis widens about .5 and its amplitude decreases by
 * the reciprocal scale. Each level has the same integrated image mass; a finite
 * stamp keeps fading after becoming subpixel instead of acquiring a mean plateau.
 */
function levelSample(image: ImageResource, levels: readonly ImageResource[], uv: readonly [number, number], address: ImageAddress, level: number): ImageSample {
  const stored = levels[Math.min(level, levels.length - 1)];
  if (address !== 'zero') return sampleImage(stored, uv, address);
  const inverse = [image.width, image.height].map(size => 2 ** Math.min(0, Math.log2(size) - level));
  const coordinate = uv.map((value, i) => inverse[i] === 1 ? value : .5 + (value - .5) * inverse[i]) as [number, number];
  const sample = sampleImage(stored, coordinate, 'zero');
  // Sequential scaling avoids prematurely underflowing the area factor when
  // source values are large. Keep this order identical in the shader lowering.
  for (let i = 0; i < 3; i++) {
    sample.value[i] = sample.value[i] * inverse[0] * inverse[1];
    sample.du[i] = sample.du[i] * inverse[0] * inverse[1] * inverse[0];
    sample.dv[i] = sample.dv[i] * inverse[0] * inverse[1] * inverse[1];
  }
  return sample;
}

/**
 * Trilinear reconstruction, optionally averaged along at most eight major-axis
 * midpoint taps. This is a bounded anisotropic approximation, not EWA or an
 * exact pixel integral. Returned UV partials hold footprint, LOD and tap offsets
 * fixed, so normal field chain and product rules apply to the reconstruction.
 */
function samplePlannedImage(image: ImageResource, uv: readonly [number, number], address: ImageAddress,
    plan: ImageFilterPlan, levels?: readonly ImageResource[]): ImageSample {
  if (plan.lod === 0 && plan.taps === 1) return sampleImage(image, uv, address);
  const low = Math.floor(plan.lod), fraction = plan.lod - low;
  // Choose the periodic representative before adding local tap displacements.
  // Footprint construction still used the unwrapped coordinates/differentials.
  const center = address === 'repeat' ? uv.map(value => value - Math.floor(value)) : uv;
  const result: ImageSample = {value: [0, 0, 0], du: [0, 0, 0], dv: [0, 0, 0]};
  for (let tap = 0; tap < plan.taps; tap++) {
    const offset = tap + .5 - .5 * plan.taps;
    const coordinate: [number, number] = [center[0] + offset * plan.step[0], center[1] + offset * plan.step[1]];
    const a = levelSample(image, levels!, coordinate, address, low);
    const b = fraction === 0 ? a : levelSample(image, levels!, coordinate, address, low + 1);
    for (const key of ['value', 'du', 'dv'] as const) for (let channel = 0; channel < 3; channel++) {
      result[key][channel] += (a[key][channel] * (1 - fraction) + b[key][channel] * fraction) / plan.taps;
    }
  }
  return result;
}

export function sampleFilteredImage(image: ImageResource, uv: readonly [number, number], address: ImageAddress = 'clamp', filter: ImageFilter = 'trilinear', footprint?: ImageFootprint): ImageSample {
  const plan = imageFilterPlan(image, footprint, filter, address);
  const levels = plan.lod === 0 && plan.taps === 1 ? undefined : imagePyramid(image);
  return samplePlannedImage(image, uv, address, plan, levels);
}

/** Fixed-footprint authoring/bake sampler. Planning and mip lookup happen once. */
export function prepareImageSampler(resource: ImageResource, address: ImageAddress = 'clamp', filter: ImageFilter = 'trilinear', footprint?: ImageFootprint): (uv: readonly [number, number]) => ImageSample {
  const image = normalizeImage(resource), plan = imageFilterPlan(image, footprint, filter, address);
  const levels = plan.lod === 0 && plan.taps === 1 ? undefined : imagePyramid(image);
  return uv => samplePlannedImage(image, uv, address, plan, levels);
}

import {ownFrozen} from './ownership.mts';
import type {ImageResource, ImageAddress, ImageChannel, Vec3} from './algebra.mts';

export interface ImageShape {readonly width: number; readonly height: number; readonly channels: 1 | 3}
export interface ImageInput extends ImageShape {readonly data: readonly number[] | Float32Array}
export interface ImageSample {readonly value: [number, number, number]; readonly du: [number, number, number]; readonly dv: [number, number, number]}
export type ImageGenerator<T> = (u: number, v: number, x: number, y: number) => T;

/** Immutable numeric images. Values are float32; color readers use linear RGB. */
export const IMAGE_LIMITS = Object.freeze({dimension: 4096, components: 262144});

type ChannelRange = readonly [number, number];
// The immutable resource owns at most one lazy range per stored channel.
// This registry is also its construction proof; no graph or revision is retained.
const owned = new WeakMap<object, (ChannelRange | undefined)[]>();
const channelIndex = {r: 0, g: 1, b: 2} as const;
const FLOAT32_MAX = 3.4028234663852886e38;

function record(input: unknown, name: string, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  for (const key of Object.keys(input)) if (!keys.includes(key)) {
    throw new TypeError(`Unknown ${name} property: ${key}.`);
  }
}

function shape(input: Readonly<Record<string, unknown>>): ImageShape {
  const {width, height, channels} = input;
  for (const [name, size] of [['width', width], ['height', height]]) {
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > IMAGE_LIMITS.dimension) {
      throw new RangeError(`Image ${name} must be an integer in [1, ${IMAGE_LIMITS.dimension}].`);
    }
  }
  if (channels !== 1 && channels !== 3) throw new RangeError('Image channels must be 1 or 3.');
  if (typeof width !== 'number' || typeof height !== 'number') throw new TypeError('Image dimensions must be numbers.');
  if (width * height * channels > IMAGE_LIMITS.components) {
    throw new RangeError(`An image may contain at most ${IMAGE_LIMITS.components} components.`);
  }
  return {width, height, channels};
}

function component(value: unknown, index: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > FLOAT32_MAX) {
    throw new RangeError(`Image data[${index}] must be a finite float32 value.`);
  }
  // Quantize once at the ownership boundary, matching a float texture upload.
  const result = Math.fround(value);
  return Object.is(result, -0) ? 0 : result;
}

function publish(dimensions: ImageShape, data: number[]): ImageResource {
  const result = ownFrozen(Object.freeze({...dimensions, data: Object.freeze(data)}));
  owned.set(result, []);
  return result;
}

/** Ownership is a construction proof, never inferred from an object's shape. */
export const isNormalizedImage = (input: unknown): input is ImageResource =>
  typeof input === 'object' && input !== null && owned.has(input);

/** Row-major data starts at the lower-left texel. Caller-owned data is copied. */
export function normalizeImage(input: unknown): ImageResource {
  if (isNormalizedImage(input)) return input;
  record(input, 'image resource', ['width', 'height', 'channels', 'data']);
  const dimensions = shape(input), {data} = input;
  if ((!Array.isArray(data) && !(data instanceof Float32Array))
      || data.length !== dimensions.width * dimensions.height * dimensions.channels) {
    throw new TypeError('Image data must have width × height × channels numeric components.');
  }
  return publish(dimensions, Array.from(data, component));
}

/** Image bounds depend on the resource, not a reader's mapping or filter. */
export function imageChannelRange(resource: ImageResource, channel: ImageChannel): ChannelRange {
  const image = normalizeImage(resource), index = image.channels === 1 ? 0 : channelIndex[channel];
  const ranges = owned.get(image)!;
  const previous = ranges[index];
  if (previous) return previous;
  let low = Infinity, high = -Infinity;
  for (let i = index; i < image.data.length; i += image.channels) {
    const value = image.data[i];
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return ranges[index] = Object.freeze([low, high]);
}

/**
 * Authoring-time tabulation. The callback runs once per texel and is discarded;
 * the returned resource contains only serializable data. Coordinates are texel
 * centers in [0,1]², followed by integer column and row: sample(u, v, x, y).
 */
export function generateImage(options: ImageShape, sample: ImageGenerator<number | Vec3>): ImageResource {
  record(options, 'image generation options', ['width', 'height', 'channels']);
  const dimensions = shape(options), {width, height, channels} = dimensions;
  if (typeof sample !== 'function') throw new TypeError('Image generation requires a sample function.');
  const data = new Array<number>(width * height * channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = sample((x + .5) / width, (y + .5) / height, x, y);
    const offset = (y * width + x) * channels;
    if (channels === 1) data[offset] = component(value, offset);
    else {
      if (!Array.isArray(value) || value.length !== 3) {
        throw new TypeError(`Image sample at (${x}, ${y}) must return three linear RGB components.`);
      }
      for (let channel = 0; channel < 3; channel++) data[offset + channel] = component(value[channel], offset + channel);
    }
  }
  return publish(dimensions, data);
}

const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;

/**
 * Base-level bilinear reconstruction and its analytic UV partial derivatives.
 * Resource, coordinates and addressing have already crossed their validation
 * boundaries. Scalar resources repeat into RGB. Index clamping makes the outer
 * half texels constant; periodic indices interpolate across the repeat seam.
 * Zero addressing extends the texel lattice with zeros, including its analytic
 * boundary ramps. It does not clamp coordinates to the image's rectangle.
 * At an interior texel center, floor selects the cell to its right/above. The
 * value is continuous, but derivatives are one-sided there, not globally C1.
 * This is a point reconstruction, not a mipmapped or anisotropic pixel average.
 */
export function sampleImage(image: ImageResource, uv: readonly [number, number], address: ImageAddress = 'clamp'): ImageSample {
  const {width, height, channels, data} = image;
  const repeat = address === 'repeat', outsideZero = address === 'zero';
  // Test support before forming texel indices, including for huge coordinates.
  // The left boundary keeps its right-sided derivative; the right boundary's
  // selected cell is already entirely outside the image.
  if (outsideZero && (uv[0] < -.5 / width || uv[0] >= 1 + .5 / width
      || uv[1] < -.5 / height || uv[1] >= 1 + .5 / height)) {
    return {value: [0, 0, 0], du: [0, 0, 0], dv: [0, 0, 0]};
  }
  const coordinate = (value: number) => repeat ? value - Math.floor(value)
    : outsideZero ? value : Math.max(0, Math.min(1, value));
  const x = coordinate(uv[0]) * width - .5, y = coordinate(uv[1]) * height - .5;
  const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
  const index = (value: number, size: number) => repeat ? (value + size) % size
    : outsideZero ? value : Math.max(0, Math.min(size - 1, value));
  const x0 = index(ix, width), x1 = index(ix + 1, width), y0 = index(iy, height), y1 = index(iy + 1, height);
  const offset = (x: number, y: number) => x < 0 || x >= width || y < 0 || y >= height
    ? -1 : (y * width + x) * channels;
  const offsets = [offset(x0, y0), offset(x1, y0), offset(x0, y1), offset(x1, y1)];
  const texel = (offset: number, channel: number) => offset < 0 ? 0 : data[offset + channel];
  const value: [number, number, number] = [0, 0, 0], du: [number, number, number] = [0, 0, 0], dv: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < channels; channel++) {
    const a = texel(offsets[0], channel), b = texel(offsets[1], channel);
    const c = texel(offsets[2], channel), d = texel(offsets[3], channel);
    const lower = mix(a, b, tx), upper = mix(c, d, tx);
    value[channel] = mix(lower, upper, ty);
    du[channel] = mix(b - a, d - c, ty) * width;
    dv[channel] = (upper - lower) * height;
  }
  if (channels === 1) for (const components of [value, du, dv]) components[1] = components[2] = components[0];
  return {value, du, dv};
}

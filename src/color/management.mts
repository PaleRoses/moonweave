import {finite, FLOAT32_MAX, record} from '../core/algebra.mts';
import type {ImageResource, Vec3} from '../core/algebra.mts';
import {linearToOklab, oklabToLinear, oklchToLinear, multiplyColorMatrix,
  decodeSrgbChannel as decode, encodeSrgbChannel as encode} from '../core/color.mts';
import {normalizeImage} from '../core/resources.mts';

/** Source coordinates are explicit; graph colors have only linear Rec.709 coordinates. */
export type ManagedColorSpace = 'linear-rec709' | 'srgb' | 'display-p3' | 'linear-display-p3' | 'oklab' | 'oklch';
export type DisplayColorSpace = 'srgb' | 'display-p3';
export interface TaggedColor<S extends ManagedColorSpace = ManagedColorSpace> {
  readonly space: S;
  /** RGB and Oklab lightness use a nominal 0–1 range; OKLCH hue is in degrees. */
  readonly coords: Vec3;
}

type Matrix = readonly [Vec3, Vec3, Vec3];
const spaces: readonly ManagedColorSpace[] = Object.freeze([
  'linear-rec709', 'srgb', 'display-p3', 'linear-display-p3', 'oklab', 'oklch',
]);
const vector = (value: unknown, name: string): Vec3 => {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${name} requires three coordinates.`);
  return [finite(value[0], name, FLOAT32_MAX), finite(value[1], name, FLOAT32_MAX), finite(value[2], name, FLOAT32_MAX)];
};
const coordinates = (value: Vec3, apply: (v: number) => number): Vec3 => [apply(value[0]), apply(value[1]), apply(value[2])];
const clip = (v: number) => Math.max(0, Math.min(1, v));
const bounded = (value: Vec3) => value.every(v => v >= 0 && v <= 1);

function compose(a: Matrix, b: Matrix): Matrix {
  const x = multiplyColorMatrix(a, [b[0][0], b[1][0], b[2][0]]);
  const y = multiplyColorMatrix(a, [b[0][1], b[1][1], b[2][1]]);
  const z = multiplyColorMatrix(a, [b[0][2], b[1][2], b[2][2]]);
  return Object.freeze([
    Object.freeze([x[0], y[0], z[0]] as const), Object.freeze([x[1], y[1], z[1]] as const),
    Object.freeze([x[2], y[2], z[2]] as const),
  ]);
}

// D65 primary transforms and reflected sRGB transfer curves follow CSS Color 4
// §19. Compose the XYZ bridge once; no chromatic adaptation is needed between
// these two D65 spaces. See COLOR-LICENSE.txt for the complete upstream notice.
const p3ToWorking = compose([
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
], [
  [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
  [35783 / 156275, 247089 / 357200, 198249 / 2500400],
  [0, 32229 / 714400, 5220557 / 5000800],
]);
const workingToP3 = compose([
  [446124 / 178915, -333277 / 357830, -72051 / 178915],
  [-14852 / 17905, 63121 / 35810, 423 / 17905],
  [11844 / 330415, -50337 / 660830, 316169 / 330415],
], [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
]);

function colorSpace(value: ManagedColorSpace): ManagedColorSpace {
  if (!spaces.includes(value)) throw new TypeError(`Unknown color space: ${String(value)}.`);
  return value;
}

function displaySpace(value: DisplayColorSpace): DisplayColorSpace {
  if (value !== 'srgb' && value !== 'display-p3') throw new TypeError('Display output requires srgb or display-p3.');
  return value;
}

function inputColor(input: TaggedColor): TaggedColor {
  record(input, 'tagged color', ['space', 'coords']);
  const space = colorSpace(input.space), coords = vector(input.coords, 'color');
  if (space === 'oklch' && coords[1] < 0) throw new RangeError('OKLCH chroma must be nonnegative.');
  return {space, coords};
}

function toLinear(value: Vec3, space: ManagedColorSpace): Vec3 {
  switch (space) {
    case 'linear-rec709': return value;
    case 'srgb': return coordinates(value, decode);
    case 'display-p3': return multiplyColorMatrix(p3ToWorking, coordinates(value, decode));
    case 'linear-display-p3': return multiplyColorMatrix(p3ToWorking, value);
    case 'oklab': return oklabToLinear(value);
    case 'oklch': return oklchToLinear(value);
  }
}

function fromLinear(value: Vec3, space: ManagedColorSpace): Vec3 {
  switch (space) {
    case 'linear-rec709': return value;
    case 'srgb': return coordinates(value, encode);
    case 'display-p3': return coordinates(multiplyColorMatrix(workingToP3, value), encode);
    case 'linear-display-p3': return multiplyColorMatrix(workingToP3, value);
    case 'oklab': return linearToOklab(value);
    case 'oklch': {
      const [l, a, b] = linearToOklab(value), chroma = Math.hypot(a, b);
      // Achromatic colors use a canonical zero hue rather than a NaN sentinel.
      return [l, chroma, chroma < 1e-14 ? 0 : (Math.atan2(b, a) * 180 / Math.PI + 360) % 360];
    }
  }
}

/** Convert once at authoring/import. Negative and above-one coordinates survive. */
export function toWorkingColor(input: TaggedColor): Vec3 {
  const color = inputColor(input);
  return Object.freeze(vector(toLinear(color.coords, color.space), 'working color'));
}

/** Coordinate conversion is lossless apart from floating point; it never gamut maps. */
export function convertColor<S extends ManagedColorSpace>(input: TaggedColor, space: S): TaggedColor<S> {
  const color = inputColor(input);
  colorSpace(space);
  const value = color.space === space ? color.coords : fromLinear(toLinear(color.coords, color.space), space);
  return Object.freeze({space, coords: Object.freeze(vector(value, 'converted color'))});
}

/**
 * CSS Color 4 §14.2.2, binary search with local MINDE in Oklab. This is a
 * relative-colorimetric display boundary: in-gamut colors are unchanged;
 * out-of-gamut colors reduce OKLCH chroma until the clipped difference is below
 * one JND. It is neither HDR tone mapping nor an ICC/photo rendering intent.
 */
function mapDisplay(working: Vec3, destination: DisplayColorSpace): Vec3 {
  const target = (rgb: Vec3) => destination === 'srgb' ? rgb : multiplyColorMatrix(workingToP3, rgb);
  const source = (rgb: Vec3) => destination === 'srgb' ? rgb : multiplyColorMatrix(p3ToWorking, rgb);
  const original = target(working);
  if (bounded(original)) return original;
  const lab = linearToOklab(working), [lightness, a, b] = lab;
  if (lightness >= 1) return [1, 1, 1];
  if (lightness <= 0) return [0, 0, 0];
  const chroma = Math.hypot(a, b), epsilon = .0001, jnd = .02;
  const difference = (clipped: Vec3, current: Vec3) => {
    const mapped = linearToOklab(source(clipped));
    return Math.hypot(mapped[0] - current[0], mapped[1] - current[1], mapped[2] - current[2]);
  };
  let clipped = coordinates(original, clip);
  if (difference(clipped, lab) < jnd || chroma === 0) return clipped;
  let low = 0, high = chroma, lowInGamut = true;
  while (high - low > epsilon) {
    const middle = (low + high) / 2;
    const current: Vec3 = [lightness, a * (middle / chroma), b * (middle / chroma)];
    const candidate = target(oklabToLinear(current));
    if (lowInGamut && bounded(candidate)) {
      low = middle;
      continue;
    }
    clipped = coordinates(candidate, clip);
    const delta = difference(clipped, current);
    if (delta < jnd) {
      if (jnd - delta < epsilon) return clipped;
      lowInGamut = false;
      low = middle;
    } else high = middle;
  }
  return clipped;
}

/** Explicit gamut mapping, followed by the destination's encoding transfer curve. */
export function displayColor<S extends DisplayColorSpace>(input: TaggedColor, space: S): TaggedColor<S> {
  const working = toWorkingColor(input);
  const value = coordinates(mapDisplay(working, displaySpace(space)), encode);
  return Object.freeze({space, coords: Object.freeze(value)});
}

function rgbImage(input: ImageResource): ImageResource {
  const image = normalizeImage(input);
  if (image.channels !== 3) throw new TypeError('Color management requires an RGB image; scalar images are unencoded data.');
  return image;
}

function mapImage(input: ImageResource, map: (rgb: Vec3) => Vec3): ImageResource {
  const image = rgbImage(input), data: number[] = new Array(image.data.length);
  for (let i = 0; i < data.length; i += 3) {
    const rgb = map([image.data[i], image.data[i + 1], image.data[i + 2]]);
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
  }
  return normalizeImage({width: image.width, height: image.height, channels: 3, data});
}

/** Decode a tagged RGB resource before graph sampling or mip generation. */
export function decodeColorImage(input: ImageResource, space: DisplayColorSpace): ImageResource {
  displaySpace(space);
  return mapImage(input, rgb => toLinear(rgb, space));
}

/** Encode an already linear graph/bake image for an explicitly selected display gamut. */
export function encodeColorImage(input: ImageResource, space: DisplayColorSpace): ImageResource {
  displaySpace(space);
  return mapImage(input, rgb => coordinates(mapDisplay(rgb, space), encode));
}

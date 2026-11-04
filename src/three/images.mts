import type {DataTexture} from 'three';
import type {ImageResource} from '../core/algebra.mts';
import type {TexturingEngine} from './engine.mts';

import {imagePyramid, MAX_IMAGE_ANISOTROPY, IMAGE_TAP_EPSILON} from '../core/image-filter.mts';

/** Base-level bilinear reconstruction. Retain this legacy kernel's exact text. */
export const IMAGE_GLSL = /* glsl */`
void mwImage(highp sampler2D source, vec2 size, vec2 uv, bool repeating,
    out vec3 value, out vec3 du, out vec3 dv) {
  vec2 q = repeating ? fract(uv) : clamp(uv, 0.0, 1.0);
  vec2 p = q * size - 0.5, cell = floor(p), f = p - cell;
  vec2 lo = repeating ? mod(cell, size) : clamp(cell, vec2(0.0), size - 1.0);
  vec2 hi = repeating ? mod(cell + 1.0, size) : clamp(cell + 1.0, vec2(0.0), size - 1.0);
  vec3 a = texture2D(source, (lo + 0.5) / size).rgb;
  vec3 b = texture2D(source, (vec2(hi.x, lo.y) + 0.5) / size).rgb;
  vec3 c = texture2D(source, (vec2(lo.x, hi.y) + 0.5) / size).rgb;
  vec3 d = texture2D(source, (hi + 0.5) / size).rgb;
  value = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  du = mix(b - a, d - c, f.y) * size.x;
  dv = mix(c - a, d - b, f.x) * size.y;
}
`;

/**
 * Explicit mip sampling keeps reconstruction, addressing and height partials
 * identical to the CPU contract. Hardware float-linear filtering is not used.
 * Address codes are clamp=0, repeat=1, zero=2. Footprint/LOD/taps are frozen when
 * taking center-coordinate partials; this is a bounded mip approximation.
 */
export const FILTERED_IMAGE_GLSL = /* glsl */`
vec3 mwImageTexel(highp sampler2D source, vec2 size, vec2 index, int level, int address) {
  if (address == 2 && (any(lessThan(index, vec2(0.0))) || any(greaterThanEqual(index, size)))) return vec3(0.0);
  vec2 bounded = address == 1 ? mod(index, size) : clamp(index, vec2(0.0), size - 1.0);
  return texelFetch(source, ivec2(bounded), level).rgb;
}

void mwImageLevel(highp sampler2D source, vec2 baseSize, vec2 uv, int level, int address,
    out vec3 value, out vec3 du, out vec3 dv) {
  int last = int(floor(log2(max(baseSize.x, baseSize.y))));
  int stored = min(level, last);
  vec2 size = vec2(textureSize(source, stored));
  vec2 inverseScale = address == 2 ? exp2(min(vec2(0.0), log2(baseSize) - float(level))) : vec2(1.0);
  vec2 q = address == 1 ? fract(uv) : address == 0 ? clamp(uv, 0.0, 1.0) : uv;
  if (inverseScale.x < 1.0) q.x = 0.5 + (uv.x - 0.5) * inverseScale.x;
  if (inverseScale.y < 1.0) q.y = 0.5 + (uv.y - 0.5) * inverseScale.y;
  if (address == 2 && (any(lessThan(q, -0.5 / size))
      || any(greaterThanEqual(q, 1.0 + 0.5 / size)))) {
    value = vec3(0.0); du = vec3(0.0); dv = vec3(0.0); return;
  }
  vec2 p = q * size - 0.5, cell = floor(p), f = p - cell;
  vec3 a = mwImageTexel(source, size, cell, stored, address);
  vec3 b = mwImageTexel(source, size, cell + vec2(1.0, 0.0), stored, address);
  vec3 c = mwImageTexel(source, size, cell + vec2(0.0, 1.0), stored, address);
  vec3 d = mwImageTexel(source, size, cell + 1.0, stored, address);
  value = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  du = mix(b - a, d - c, f.y) * size.x;
  dv = mix(c - a, d - b, f.x) * size.y;
  // Scale in sequence: forming a tiny area first can underflow even when the
  // final filtered value is representable for an extended-range image.
  value = (value * inverseScale.x) * inverseScale.y;
  du = ((du * inverseScale.x) * inverseScale.y) * inverseScale.x;
  dv = ((dv * inverseScale.x) * inverseScale.y) * inverseScale.y;
}

void mwImageTrilinear(highp sampler2D source, vec2 size, vec2 uv, float lod, int address,
    out vec3 value, out vec3 du, out vec3 dv) {
  float last = floor(log2(max(size.x, size.y)));
  float level = address == 2 ? max(0.0, lod) : clamp(lod, 0.0, last);
  int lower = int(floor(level));
  float weight = level - float(lower);
  mwImageLevel(source, size, uv, lower, address, value, du, dv);
  if (weight > 0.0) {
    vec3 upper, upperDu, upperDv;
    mwImageLevel(source, size, uv, lower + 1, address, upper, upperDu, upperDv);
    value = mix(value, upper, weight);
    du = mix(du, upperDu, weight);
    dv = mix(dv, upperDv, weight);
  }
}

void mwImageFootprint(vec2 size, vec2 dx, vec2 dy, int address, bool anisotropic,
    out float lod, out int taps, out vec2 stepUV) {
  // Constant singleton axes do not widen a footprint. Zero-extended singleton
  // axes remain finite and must still be integrated as the footprint grows.
  if (address != 2) {
    vec2 axes = vec2(size.x > 1.0 ? 1.0 : 0.0, size.y > 1.0 ? 1.0 : 0.0);
    dx *= axes; dy *= axes;
  }
  float uvScale = max(max(abs(dx.x), abs(dx.y)), max(abs(dy.x), abs(dy.y)));
  lod = 0.0; taps = 1; stepUV = vec2(0.0);
  if (uvScale == 0.0) return;
  vec2 x = (dx / uvScale) * size, y = (dy / uvScale) * size;
  float texelScale = max(max(abs(x.x), abs(x.y)), max(abs(y.x), abs(y.y)));
  x /= texelScale; y /= texelScale;
  float a = x.x * x.x + y.x * y.x, b = x.x * x.y + y.x * y.y;
  float c = x.y * x.y + y.y * y.y;
  float lambda = 0.5 * (a + c + length(vec2(a - c, 2.0 * b)));
  float root = sqrt(lambda), logScale = log2(uvScale) + log2(texelScale);
  float logMajor = logScale + log2(root);
  if (logMajor <= 0.0) return;
  if (!anisotropic) { lod = max(0.0, logMajor); return; }
  float determinant = abs(x.x * y.y - x.y * y.x);
  float logMinor = determinant > 0.0 ? logScale + log2(determinant) - log2(root) : -1e30;
  lod = max(0.0, max(logMinor, logMajor - ${Math.log2(MAX_IMAGE_ANISOTROPY)}.0));
  taps = int(clamp(ceil(exp2(logMajor - lod) - ${IMAGE_TAP_EPSILON}), 1.0, ${MAX_IMAGE_ANISOTROPY}.0));
  if (taps == 1) return;
  vec2 axis = a >= c ? vec2(lambda - c, b) : vec2(b, lambda - a);
  float magnitude = length(axis);
  axis = magnitude > 0.0 ? axis / magnitude : vec2(1.0, 0.0);
  vec2 right = vec2(dot(x, axis), dot(y, axis)) / root;
  stepUV = (dx / float(taps)) * right.x + (dy / float(taps)) * right.y;
}

void mwImageFiltered(highp sampler2D source, vec2 size, vec2 uv, vec2 dx, vec2 dy,
    int address, bool anisotropic, out vec3 value, out vec3 du, out vec3 dv) {
  float lod; int taps; vec2 stepUV;
  mwImageFootprint(size, dx, dy, address, anisotropic, lod, taps, stepUV);
  value = vec3(0.0); du = vec3(0.0); dv = vec3(0.0);
  float weight = 1.0 / float(taps);
  // Choose the periodic center before adding sub-texel tap offsets. Adding
  // them to a large translated UV would discard their low float32 bits.
  vec2 center = address == 1 ? fract(uv) : uv;
  for (int i = 0; i < ${MAX_IMAGE_ANISOTROPY}; i++) {
    if (i >= taps) break;
    vec3 sampleValue, sampleDu, sampleDv;
    vec2 point = center + (float(i) + 0.5 - 0.5 * float(taps)) * stepUV;
    mwImageTrilinear(source, size, point, lod, address, sampleValue, sampleDu, sampleDv);
    value += sampleValue * weight;
    du += sampleDu * weight;
    dv += sampleDv * weight;
  }
}
`;

/** The renderer and native harness upload the same explicit RGBA32F levels. */
export function imageTextureLevels(resource: ImageResource) {
  return imagePyramid(resource).map(({width, height, channels, data}) => {
    const pixels = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < 3; c++) pixels[i * 4 + c] = data[i * channels + (channels === 1 ? 0 : c)];
      pixels[i * 4 + 3] = 1;
    }
    return {data: pixels, width, height};
  });
}

/** One texture per owned resource identity, shared across live materials. */
export function createImageTextures(THREE: TexturingEngine) {
  const entries = new Map<ImageResource, {texture: DataTexture; count: number}>();
  function acquire(resource: ImageResource) {
    let entry = entries.get(resource);
    if (!entry) {
      if (!THREE.DataTexture || THREE.FloatType === undefined || THREE.NearestFilter === undefined) {
        throw new TypeError('Image fields require Three.js float data textures.');
      }
      const mipmaps = imageTextureLevels(resource);
      const {width, height, data: pixels} = mipmaps[0];
      const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
      texture.name = 'Moonweave image field';
      // Allocate the complete pyramid once. Sampling policy belongs to readers,
      // so linear and filtered uses retain one shared texture and one lifetime.
      texture.mipmaps = mipmaps;
      texture.minFilter = texture.magFilter = THREE.NearestFilter;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.generateMipmaps = false;
      texture.flipY = false;
      if ('colorSpace' in texture) texture.colorSpace = THREE.NoColorSpace ?? '';
      texture.needsUpdate = true;
      entry = {texture, count: 0};
      entries.set(resource, entry);
    }
    entry.count++;
    return entry.texture;
  }
  function release(resource: ImageResource) {
    const entry = entries.get(resource);
    if (entry && --entry.count === 0) {
      entries.delete(resource);
      entry.texture.dispose();
    }
  }
  return {acquire, release};
}

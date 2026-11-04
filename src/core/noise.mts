import type {Vec3} from './algebra.mts';

/** Cell period on each axis; wrap the lattice before converting to GPU uint. */
export const NOISE_PERIOD = 65536;
export interface NoiseSample {readonly value: number; readonly gradient: Vec3}

// PCG RXS-M-XS (O'Neill), nested for independent coordinate inputs as studied
// by Jarzynski and Olano, https://jcgt.org/published/0009/03/02/.
// Every integer operation matches uint32 GLSL; no transcendental float hash.
function hash(input: number): number {
  const state = (Math.imul(input, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737);
  return (word ^ (word >>> 22)) >>> 0;
}

const wrap = (value: number) => value - Math.floor(value / NOISE_PERIOD) * NOISE_PERIOD;
const fade = (value: number) => value * value * value * (value * (value * 6 - 15) + 10);
const slope = (value: number) => 30 * value * value * (value - 1) * (value - 1);
const mix = (a: number, b: number, weight: number) => a + (b - a) * weight;
// Centers of 2^23 bins: exact float32 values, symmetric around 0.5.
const unit = (value: number) => ((hash(value) >>> 9) + 0.5) / 8388608;

/**
 * One periodic, quintic value-noise octave and its analytic spatial gradient.
 * Inputs have already passed graph/sample validation. This is a point sample,
 * not a filtered pixel average. CPU interpolation uses JS number precision;
 * shaders use float32, so interpolation is numerically close, not bit-identical.
 */
export function sampleNoise(position: Vec3, seed: number): NoiseSample {
  const [x, y, z] = position;
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const ix = wrap(fx), iy = wrap(fy), iz = wrap(fz);
  const jx = (ix + 1) & 65535, jy = (iy + 1) & 65535, jz = (iz + 1) & 65535;
  const tx = x - fx, ty = y - fy, tz = z - fz;
  const u = fade(tx), v = fade(ty), w = fade(tz);

  // Share intermediate hashes: two z, four y, eight x; fixed work, no octaves.
  const z0 = hash(iz + seed), z1 = hash(jz + seed);
  const y00 = hash(iy + z0), y10 = hash(jy + z0);
  const y01 = hash(iy + z1), y11 = hash(jy + z1);
  const a = unit(ix + y00), b = unit(jx + y00);
  const c = unit(ix + y10), d = unit(jx + y10);
  const e = unit(ix + y01), f = unit(jx + y01);
  const g = unit(ix + y11), h = unit(jx + y11);
  const ab = mix(a, b, u), cd = mix(c, d, u), ef = mix(e, f, u), gh = mix(g, h, u);
  const lower = mix(ab, cd, v), upper = mix(ef, gh, v);
  return {
    value: mix(lower, upper, w),
    gradient: [
      mix(mix(b - a, d - c, v), mix(f - e, h - g, v), w) * slope(tx),
      mix(cd - ab, gh - ef, w) * slope(ty),
      (upper - lower) * slope(tz),
    ],
  };
}

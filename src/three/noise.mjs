/** Shared lattice kernel for value-only and analytic-gradient noise programs. */
const hashFunctions = /* glsl */`
uint mwNoiseHash(uint inputValue) {
  uint state = inputValue * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return word ^ (word >> 22u);
}

float mwNoiseUnit(uint inputValue) {
  return (float(mwNoiseHash(inputValue) >> 9u) + 0.5) / 8388608.0;
}

`;

const lattice = /* glsl */`
  // Wrapping an integer-valued float by a power of two is safe before uint
  // conversion, including negative and large coordinates. Fractional detail
  // still has the usual float32 precision limit at large domain magnitudes.
  vec3 cell = floor(p);
  uvec3 i = uvec3(mod(cell, 65536.0));
  uvec3 j = (i + uvec3(1u)) & uvec3(65535u);
  vec3 t = p - cell;
  vec3 q = clamp(t * t * t * (t * (t * 6.0 - 15.0) + 10.0), 0.0, 1.0);

  uint z0 = mwNoiseHash(i.z + seed), z1 = mwNoiseHash(j.z + seed);
  uint y00 = mwNoiseHash(i.y + z0), y10 = mwNoiseHash(j.y + z0);
  uint y01 = mwNoiseHash(i.y + z1), y11 = mwNoiseHash(j.y + z1);
  float a = mwNoiseUnit(i.x + y00), b = mwNoiseUnit(j.x + y00);
  float c = mwNoiseUnit(i.x + y10), d = mwNoiseUnit(j.x + y10);
  float e = mwNoiseUnit(i.x + y01), f = mwNoiseUnit(j.x + y01);
  float g = mwNoiseUnit(i.x + y11), h = mwNoiseUnit(j.x + y11);
  float lower = mix(mix(a, b, q.x), mix(c, d, q.x), q.y);
  float upper = mix(mix(e, f, q.x), mix(g, h, q.x), q.y);
`;

const gradient = /* glsl */`
  vec3 fadeSlope = 30.0 * t * t * (t - 1.0) * (t - 1.0);
  gradient = vec3(
    mix(mix(b - a, d - c, q.y), mix(f - e, h - g, q.y), q.z) * fadeSlope.x,
    mix(mix(c, d, q.x) - mix(a, b, q.x), mix(g, h, q.x) - mix(e, f, q.x), q.z) * fadeSlope.y,
    (upper - lower) * fadeSlope.z);
`;

/** Emit only the forms demanded by the live scalar graph; lattice hashes are shared. */
export function noiseGLSL({value = false, differential = false}) {
  if (!value && !differential) return '';
  const sample = withGradient => `
float ${withGradient ? 'mwNoiseSample(vec3 p, uint seed, out vec3 gradient)' : 'mwNoise(vec3 p, uint seed)'} {${lattice}${withGradient ? gradient : ''}
  return clamp(mix(lower, upper, q.z), 0.0, 1.0);
}
`;
  return hashFunctions + (value ? sample(false) : '') + (differential ? sample(true) : '');
}

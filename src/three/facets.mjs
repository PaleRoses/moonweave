import {PAINT_CELLS} from '../paint/data.mts';

/** Atlas field sampling is included only when the live graph uses facets. */
export const FACETS_GLSL = /* glsl */`
uniform sampler2D uMwTop;
uniform sampler2D uMwWall;
uniform float uMwResolution;

struct MoonweaveField {
  float macro;
  float body;
  float ink;
  float light;
  float grain;
  vec2 slope;
};
MoonweaveField mwSample(vec3 p, vec3 n, float scale, vec3 stretch, vec2 direction, vec3 offset) {
  vec2 perpendicular = vec2(-direction.y, direction.x);
  vec3 rotated = vec3(dot(p.xz, direction), p.y, dot(p.xz, perpendicular));
  vec3 q = (rotated / stretch + offset) / (scale * ${PAINT_CELLS.toFixed(1)});
  vec3 qNormal = vec3(dot(n.xz, direction), n.y, dot(n.xz, perpendicular)) * stretch;
  vec3 weights = abs(mwNormalize(qNormal));
  weights *= weights; weights *= weights;
  weights /= max(dot(weights, vec3(1.0)), 0.000001);

  // Every projection is sampled and differentiated before any mask composition.
  vec3 dx = dFdx(q), dy = dFdy(q);
  vec4 px = texture2D(uMwWall, q.zy);
  vec4 py = texture2D(uMwTop, q.xz);
  vec4 pz = texture2D(uMwWall, q.xy);
  float macro = texture2D(uMwTop, q.xz * 0.14 + vec2(0.17, 0.43)).r;
  vec3 pixels = uMwResolution * vec3(
    max(length(dx.zy), length(dy.zy)),
    max(length(dx.xz), length(dy.xz)),
    max(length(dx.xy), length(dy.xy)));
  vec3 keep = 1.0 - smoothstep(vec3(1.4), vec3(7.0), pixels);
  vec3 pigment = vec3(px.r, py.r, pz.r);
  vec3 planes = vec3(px.g, py.g, pz.g);
  vec3 aa = max(fwidth(planes) * 0.45, vec3(0.008));
  // Filtering and nonlinear mark extraction belong to each projection.
  // A retired projection cannot borrow another projection's LOD weight.
  vec3 ink = (1.0 - smoothstep(vec3(0.23) - aa, vec3(0.34) + aa, planes)) * keep;
  vec3 light = smoothstep(vec3(0.61) - aa, vec3(0.82) + aa, planes) * keep;

  // BA encodes authored slopes, never a derivative of quantized pigment.
  vec2 gx = (px.ba - vec2(128.0 / 255.0)) * (255.0 / 127.0);
  vec2 gy = (py.ba - vec2(128.0 / 255.0)) * (255.0 / 127.0);
  vec2 gz = (pz.ba - vec2(128.0 / 255.0)) * (255.0 / 127.0);
  vec3 sx = vec3(dot(gx, dx.zy), dot(gy, dx.xz), dot(gz, dx.xy));
  vec3 sy = vec3(dot(gx, dy.zy), dot(gy, dy.xz), dot(gz, dy.xy));
  MoonweaveField result;
  result.macro = macro;
  result.body = 0.5 + dot((planes - 0.5) * keep, weights);
  result.ink = dot(ink * (0.65 + pigment * 0.35), weights);
  result.light = dot(light, weights);
  result.grain = dot(pigment, weights);
  result.slope = vec2(dot(sx * keep, weights), dot(sy * keep, weights));
  result.slope *= scale * ${PAINT_CELLS.toFixed(1)} * 0.13;
  return result;
}

MoonweaveSurface mwPaint(MoonweaveField field, vec3 base, vec3 shadow, vec3 light,
    vec4 pigment, vec4 finish, vec2 response) {
  float quiet = mix(1.0, smoothstep(0.20, 0.73, field.macro), pigment.w * 0.82);
  float underpaint = (field.macro - 0.5) * pigment.y * 0.50;
  float plane = (field.body - 0.5) * pigment.x * mix(0.65, 1.0, quiet);
  float tone = clamp(0.5 + underpaint + plane, 0.0, 1.0);
  vec3 color = mix(shadow, base, smoothstep(0.0, 0.52, tone));
  color = mix(color, light, smoothstep(0.5, 1.0, tone) * 0.74);
  float accents = quiet * pigment.z;
  color = mix(color, shadow, field.ink * accents);
  color = mix(color, light, field.light * accents * 0.65);
  color *= 1.0 + (field.grain - 0.5) * pigment.y * 0.16;
  MoonweaveSurface result;
  result.color = max(color, vec3(0.0));
  result.slope = field.slope * response.x;
  result.roughness = clamp(finish.x + (field.grain - 0.5) * finish.y, 0.0, 1.0);
  result.metalness = finish.z;
  result.clearcoat = finish.w;
  result.opacity = response.y;
  return result;
}

`;

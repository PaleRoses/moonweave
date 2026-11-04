# Procedural applications for LLM authors

Moonweave accepts a complete, generated surface program: image resources,
coordinate maps, coverage fields, pigments, finish and height. An LLM can create
every input through the renderer-free API, serialize the resulting graph, and
apply it to another creature. Resource callbacks run during construction. The
saved graph contains their numeric results and has no callback, file picker or
interactive painting dependency.

Start with the public entry point `@moonweave/surfaces/core`. Public declarations
are generated from their owning TypeScript implementations; the complete operation signature is in
`src/core/algebra.mts`. The Three adapter is a separate `/three` entry point.

## A complete generated application

This example tabulates a brush and a spectral palette, places them in object
coordinates, then applies quiet body, pigment and finish zones. It runs in Node
without Three, a canvas or a browser.

```js
import {
  applyZones, color, coverage, domain, image, materialGraph, named,
  pigment, scalar, serializeGraph, surface, zone,
} from '@moonweave/surfaces/core';

const brush = named('brush', image.generate(
  {width: 32, height: 32, channels: 1},
  (u, v) => {
    const x = (u - .5) / .34, y = (v - .5) / .44;
    const footprint = Math.max(0, 1 - x * x - y * y);
    const ribbons = .8 + .2 * Math.cos(u * Math.PI * 14);
    return footprint * footprint * ribbons;
  },
));

const yellow = pigment.srgb('#dcc878');
const blue = pigment.srgb('#315e79');
const palette = named('pigmentTable', image.generate(
  {width: 64, height: 1, channels: 3},
  (_u, _v, x) => pigment.toLinear(pigment.mix(yellow, blue, x / 63)),
));

const brushSpace = named('brushSpace', domain.transform([
  .55, -.15, 0, 0,
  .18, .38, 0, 0,
  0, 0, 1, 0,
  .57, .5, 0, 1,
]));
const paletteSpace = domain.transform([
  .15, 0, 0, 0,
  .12, 1, 0, 0,
  0, 0, 1, 0,
  .52, 0, 0, 1,
]);
const mark = scalar.image(brush, {
  domain: brushSpace, address: 'zero', filter: 'anisotropic',
});
const amount = named('amount', scalar.parameter(.85));
const wash = scalar.multiply(mark, amount);
const washColor = color.image(palette, {domain: paletteSpace, filter: 'trilinear'});
const base = surface.paint('carapace');

const graph = materialGraph(named('surface', applyZones(base, [
  zone('quietBody', coverage.complement(mark), {
    channels: {roughness: .72},
  }),
  zone('pigmentWash', wash, {
    color: washColor,
    channels: {roughness: .64, metalness: .04},
    height: named('depositHeight', scalar.parameter(.003)),
  }),
])));

console.log(serializeGraph(graph));
```

The local derivative of the generated image drives the deposit height. The
same sampled `mark` is shared by the quiet-body and wash calculations. The base
paint keeps its facet structure, and the wash independently changes pigment,
finish and height.

Three fuller studies are executable in the source checkout:

| Factory in `lab/application-examples.mts` | Atelier key | Composition |
| --- | --- | --- |
| `zonedEnamel()` | `zones` | Ivory facet paint, cobalt deposition, directional gold reveal, quiet finish |
| `spectralPatina()` | `pigments` | Brass facet paint, a baked yellow/blue spectral palette, differentiated oxidation and exposed brass |
| `inscribedGlaze()` | `inscription` | One packed control atlas, two transformed finite marks, bounded anisotropic filtering, correlated pigment deposition and polish |

All three factories generate their resources from deterministic functions.
Their small signed heights describe pigment deposition or scraping, and their
normal-facing fields are artistic exposure controls. They do not estimate mesh
curvature or simulate material weathering.

The original `zones` and `pigments` studies retain their base-level sampling
contract. `inscription` exercises filtered packed controls. Its exported factory
accepts an optional filter argument, such as `inscribedGlaze('linear')`, to compare
reconstructions while preserving the resource, placement and material choices.

## Coverage is a soft algebra

A zone takes a scalar field whose values are in `[0,1]`. This is a precondition
on the supplied field. Coverage helpers preserve that range for bounded inputs;
they do not silently normalize an arbitrary scalar field. `scalar.ramp`,
`mask.interval`, `mask.chisel`, or a bounded generated image can establish it.

| Operation | Equation | Meaning |
| --- | --- | --- |
| `coverage.intersect(a, b)` | `a * b` | Attenuate one coverage by another |
| `coverage.union(a, b)` | `a + (1 - a) * b` | Combine coverage while accounting for overlap |
| `coverage.subtract(a, b)` | `a * (1 - b)` | Remove the second coverage from the first |
| `coverage.complement(a)` | `1 - a` | Remaining coverage |

Over real numbers, union and intersection are commutative and associative. Their
identities are respectively `0` and `1`; complement exchanges them through De
Morgan's laws. These operations are not idempotent: intersecting `.5` with itself
gives `.25`, while their union gives `.75`. They describe graded coverage, not
Boolean membership or signed distances.

The implementation retains the written floating-point grouping. In particular,
union uses `a + (1-a)*b`, which preserves tiny `a` when `b` is zero and requires
one fewer scalar operation than `1-(1-a)*(1-b)`. Algebraic laws do not authorize
arbitrary floating-point reassociation. Compile-time identities apply to literal
constants; editable parameters stay live even when their current value is zero.

## Zones are ordered surface applications

```js
zone('name', coverageField, {
  color: colorExpression,             // optional
  channels: {roughness: scalarField}, // optional; also metalness, clearcoat, opacity
  height: scalarField,               // optional, signed
});
```

`zone` snapshots caller-owned data and returns an immutable record. Already-owned
expressions remain shared. Its name becomes the coverage root's node ID, so it
survives serialization and is prefixed by `instantiate` along with other local
IDs. Use distinct names for independently authored zones. Reuse a constructed
expression object when two zones intentionally share a field.

`applyZones(surface, zones)` folds the array from first to last. Within a zone:

1. `surface.coat` changes linear pigment toward the target under the mask,
   preserving existing finish, opacity and slope.
2. Supplied finish channels interpolate toward their targets under the same
   mask. Omitted channels retain their previous values.
3. Height contributes the differential of `coverage * height` to the current
   slope.

Color and finish targets therefore have authored precedence. A later fully
covered target replaces an earlier target for its specified channel. Heights
accumulate. Applying an empty list returns the exact original expression;
applying concatenated lists is structurally the same as applying each list in
order. An empty zone is also an identity. No zone interpreter or hidden runtime
callback is added: the helper lowers to ordinary graph operations.

For a mask `m` and deposited height `h`, the differential is

\[
D(mh)=m\,Dh+h\,Dm.
\]

This matters even when `h` is constant. A flat deposit still has a transition at
the edge of its coverage. Scaling an existing slope by `m` would lose `h Dm`.
`surface.bump` applies the full height differential; `surface.relief` is the
separate operation for scaling an already-authored slope. Neither operation
displaces geometry.

Surface color and finish interpolation clamp coverage at their material
boundaries. Height multiplication uses the supplied scalar directly. Keeping
zone coverage bounded makes all three effects agree; passing an unbounded
field violates the zone contract.

## Images are graph data

`image.data({width, height, channels, data})` creates an owned image expression.
`image.generate(shape, sample)` creates the same representation by tabulating a
function. The function receives `(u, v, x, y)`, where `u,v` are normalized texel
centers and `x,y` are integer column and row indices. It runs once per texel.

| Contract | Value |
| --- | --- |
| Resource sort | `Image`, independent of its readers |
| Storage | Row-major samples, first row at the lower edge |
| Channels | One scalar channel or three numeric channels; color readers interpret the triple as linear RGB |
| Numeric ownership | Copy once and quantize to float32; caller arrays remain mutable |
| Dimensions | Each integer dimension is from `1` through `4096` |
| Component budget | At most `262144` numeric components across all image nodes in one graph |
| Graph JSON budget | `16 MiB` |
| Scalar reader | `scalar.image(resource, {domain?, address?, filter?, channel?})` |
| Color reader | `color.image(resource, {domain?, address?, filter?})` |
| Sampling coordinates | `domain.position.xy`; implicit rest coordinates if no domain is given |
| Address mode | `clamp` by default, `repeat`, or finite `zero` extension |
| Filter | `linear` by default, `trilinear`, or bounded `anisotropic` |
| Scalar channel | `r` by default, or `g` / `b`; grayscale repeats into all three |
| CPU pixel footprint | Optional `context.footprint: {dx: Vec3, dy: Vec3}`; independent of derivative directions |

Image color values are already linear RGB. sRGB byte values require an explicit
decode before they become image data. Scalar channels carry numbers, not color
encodings. A width-one or height-one resource is valid, including a one-row
palette table.

A small complete saved material can contain the resource directly:

```json
{
  "version": 2,
  "nodes": [
    {"id": "ground", "kind": "color", "value": [0.6, 0.6, 0.5]},
    {"id": "body", "kind": "material", "color": "ground"},
    {"id": "ink", "kind": "color", "value": [0.04, 0.1, 0.18]},
    {
      "id": "pixels", "kind": "image",
      "resource": {"width": 2, "height": 2, "channels": 1, "data": [0, 1, 1, 0]}
    },
    {"id": "wash", "kind": "imageScalar", "image": "pixels", "address": "zero", "filter": "anisotropic", "channel": "r"},
    {"id": "finish", "kind": "coat", "input": "body", "color": "ink", "mask": "wash"}
  ],
  "output": "finish"
}
```

`imageColor` similarly references its resource through `image`, with optional
`domain` and structural `address` and `filter`. `parseGraph` accepts a Surface root;
`parseExpressionGraph` also accepts Image, Color, Scalar, Domain and Facets
roots. `createFieldSampler` evaluates Scalar, Color or Domain roots. Images are
data sources and become sampleable through a scalar or color reader.

### Reconstruction and derivatives

The reader specifies reconstruction; the resource owns only numeric texels.
Omitting `filter` or writing `filter: 'linear'` preserves the original base-level
bilinear path and canonical saved representation.

| Filter | Reconstruction | Texture-read ceiling per shared sample |
| --- | --- | --- |
| `linear` | Four neighboring base-level texels | 4 |
| `trilinear` | Bilinear reconstruction at two adjacent mip levels, blended by footprint size | 8 |
| `anisotropic` | Up to eight midpoint taps along the footprint's principal major axis, each trilinear | 64 |

Mip dimensions halve with integer floor, stopping at one texel per axis. Each
new texel averages the overlapping cells of the previous level and rounds once
to float32. Odd dimensions retain every source row and column. Scalar controls
and linear RGB use the same arithmetic. The normalized pixel footprint chooses
the scale in texel coordinates. The anisotropic policy widens its minor-axis
filter when necessary to stay within eight taps; it is a bounded line
approximation, not EWA or an exact rectangular-pixel integral.

The CPU and GPU share the addressing, texel-center convention and derivative
equations at every level. At cell boundaries, floor chooses the cell to the
right and above. Values are continuous for a fixed reconstruction; partials
can change across cells. Clamp mode extends the edge; repeat mode interpolates
across the seam. Zero mode treats neighboring texels outside the image as zero,
including the half-texel fringe around its boundary.

A finite mark must keep losing coverage when its footprint grows beyond the
entire resource. For `address: 'zero'`, virtual coarse levels widen the terminal
reconstruction around the image center and attenuate its amplitude by the
reciprocal area. A collapsed axis, including a singleton image axis, still has
finite extent. Integrated image mass is preserved in real arithmetic, with
float32 rounding in stored mip values. This avoids turning a tiny finite mark
into a constant mean mask across a large surface. [FILTERING.md](FILTERING.md)
specifies the scale-space and numerical conventions.

CPU callers provide a pixel footprint explicitly when they want minification:

```js
import {createFieldSampler} from '@moonweave/surfaces/core';

const sampleMark = createFieldSampler(mark);
const result = sampleMark({
  position: [.2, .3, 0],
  dx: [1, 0, 0], dy: [0, 1, 0], // directions in which to report derivatives
  footprint: {
    dx: [.02, .003, 0],         // rest-space displacement across one pixel
    dy: [-.001, .008, 0],
  },
});
```

Omitting the footprint is a point query, even for a filtered reader. Changing
only `dx` or `dy` changes the reported directional derivatives, not the sampled
value. A domain transforms both footprint vectors through its linear part, as
it does position differentials. GPU readers derive the screen footprint from
the unwrapped domain before applying image addressing.

For image partials `Iu,Iv` and a pulled-back domain, the evaluator uses

\[
D_x I = I_u D_x u + I_v D_x v,
\qquad
D_y I = I_u D_y u + I_v D_y v.
\]

The partials hold the footprint, selected LOD and tap configuration fixed. They
differentiate the selected reconstruction with respect to image position;
they do not differentiate how the camera changes the footprint. Tap-count
transitions are discrete. This convention makes height, color and scalar
calculus agree without introducing camera second derivatives. Explicit float
texel reads keep values and partials on the same reconstruction. The existing
facet atlas retains its own filtering policy, and procedural noise remains
point sampled.

### Pack correlated decisions before filtering

Filtering is linear in image values for a fixed reconstruction. It does not
distribute over multiplication:

\[
F(ab)\ne F(a)F(b).
\]

For a checkerboard whose coverage and height are both alternating zero and one,
the coarse average of covered height is `.5`; multiplying their separate
averages gives `.25`. When a painted decision depends on that correlation,
materialize the product during authoring:

```js
const controls = image.generate({width: 128, height: 64, channels: 3}, (u, v) => {
  const m = coverageAt(u, v);
  return [m, m * depositAt(u, v), m * polishAt(u, v)];
});
const sampling = {domain: brushSpace, address: 'zero', filter: 'anisotropic'};
const covered = scalar.image(controls, {...sampling, channel: 'r'});
const deposited = scalar.image(controls, {...sampling, channel: 'g'});
const polished = scalar.image(controls, {...sampling, channel: 'b'});
const coated = surface.coat(base, color.srgb('#214c67'), covered);
const finished = surface.channels(coated, {
  roughness: scalar.add(.68, scalar.multiply(-.28, polished)),
});
const detailed = surface.bump(finished, scalar.multiply(.0016, deposited));
```

Here `coverageAt`, `depositAt` and `polishAt` are authoring functions evaluated
only while generating the resource. The G channel already includes coverage,
so it goes directly into bump rather than through a second zone mask. The
three channels share one reconstruction. `inscribedGlaze()` makes this pattern
executable and reuses its atlas at two different placements. Other nonlinear
operations after sampling still act on reconstructed values; the system does
not automatically prefilter an arbitrary expression graph.

## Spectral quantities compose before RGB projection

`src/color/pigment.mts` and `spectral-data.mjs` adapt the numerical basis and
single-constant Kubelka–Munk calculation from
[Spectral.js 3.0.0](https://github.com/rvanwijnen/spectral.js/blob/3.0.0/spectral.js).
Its [MIT license](https://github.com/rvanwijnen/spectral.js/blob/3.0.0/LICENSE)
is retained in `src/color/SPECTRAL-LICENSE.txt` and the distributed package.

A pigment quantity stores two additive moments: effective concentration `C`
and 38 weighted `K/S` samples `W`. At a leaf, effective concentration uses D65
luminance and squared tinting strength. Zero luminance and zero reflectance are
regularized to `Number.EPSILON`. For reflectance `R`:

\[
k_\lambda=\frac{(1-R_\lambda)^2}{2R_\lambda},
\qquad W_\lambda=Ck_\lambda.
\]

`pigment.add` sums concentrations and weighted samples without normalizing.
`pigment.scale` scales both by a nonnegative amount. They form an additive cone
over real arithmetic, with `pigment.add()` as its zero. The accumulated
representation retains mixtures for further composition. Projecting each
intermediate mixture to RGB and lifting it again would discard that information.

```js
const mixture = pigment.add(
  pigment.scale(yellow, .6),
  pigment.scale(blue, .4),
);
const rgb = pigment.toLinear(mixture);
const literal = pigment.color(mixture);
```

`pigment.mix(a,b,t)` preserves Spectral.js's squared interpolation weights:
`add(scale(a,(1-t)**2), scale(b,t**2))`. This binary operation is not associative.
Choose `add` and explicit quantities when the mixture itself needs a composable
accumulation law. As elsewhere, real-number associativity does not imply bitwise
equality after a different floating-point grouping.

Projection divides `W` by `C`, recovers reflectance using the equivalent stable
form `1/(1+k+sqrt(k*k+2*k))`, integrates the 38 samples from 380 to 750 nm under
the supplied D65 observer weights, and produces extended linear Rec.709 RGB.
An empty quantity has no color and cannot be projected. The authoring module
does not perform display gamut mapping; material reflectance boundaries clamp
the resulting color.

RGB-derived spectra approximate a useful pigment-mixing behavior. They are not
measurements of a specific paint, a layered scattering solver or a calibrated
spectral renderer. `pigment.reflectance` also accepts 38 explicit reflectance
samples when available. For spatial palettes, perform spectral computation once
with `image.generate`, then sample the resulting linear RGB table at runtime.
Using `x/(width-1)` while generating a palette includes exact mixture endpoints;
the callback's `u` argument instead denotes texel centers. To sample a mixture
position `t` from the 64-texel table, use `u=(63*t+.5)/64`. Arbitrary normalized
`u` instead corresponds to `t=clamp((64*u-.5)/63,0,1)`. Interpolation between the
tabulated colors approximates the spectral curve; it is not another exact
spectral calculation. The RGB fitting basis preserves upstream samples that
slightly exceed reflectance one; explicit measured reflectances must be in
`[0,1]`.

## Patch, instance and render

```js
import {instantiate, graphExpression, materialGraph, patchGraph}
  from '@moonweave/surfaces/core';

const stronger = patchGraph(graph, {amount: {value: .95}});
const localCopy = materialGraph(instantiate(graphExpression(stronger), {
  prefix: 'leftHorn',
}));
```

Value patches preserve topology. Replacing the ordered zone list or changing
sampler addressing or filtering produces a new expression graph. Image resource payloads are
editable values; a resource patch is a complete `{resource: {...}}` replacement.
The adapter acquires and releases image textures by immutable resource identity.
Use `instantiate(...,{shared:[resourceExpression]})` when multiple instances
should borrow a resource rather than copy its local node. Domain binding acts
on readers and spatial effects; the image's numeric data stays independent of
its placements. The shared expression must be the exact reachable object in
that template. After loading a saved graph, extract the template root and its
resource root with `graphExpression` on the same immutable graph revision;
the shared expression cache preserves their identity.

For example, a saved inscription can share one authored atlas across independent
instances and still keep its parameters local:

```js
import {graphExpression, inDomain, instantiate, materialGraph, parseGraph}
  from '@moonweave/surfaces/core';

const saved = parseGraph(savedJSON);
const template = graphExpression(saved);
const atlas = graphExpression(saved, 'inscriptionAtlas');
const placed = inDomain(template, creatureFrame);
const instance = materialGraph(instantiate(placed, {
  prefix: 'leftHorn', shared: [atlas],
}));
// leftHorn_inscriptionDepth remains local; inscriptionAtlas remains shared.
```

`savedJSON` can be the exported `examples/inscription.json`; `creatureFrame` is
an authored `Domain` expression. Bind rest coordinates on the destination mesh
for stable attachment. Placement, object units and the meaning of a control
channel are explicit decisions in the generated program, so another creature
can reuse the mark without pretending that all meshes share an automatic UV
parameterization.

The host provides Three and a mesh when it needs a live material:

```js
import * as THREE from 'three';
import {createTexturingSystem, bindSurfaceCoordinates}
  from '@moonweave/surfaces/three';

const system = createTexturingSystem(THREE);
bindSurfaceCoordinates(THREE, mesh.geometry);
const handle = system.createMaterial(graph, {coordinates: 'attribute'});
mesh.material = handle.material;
handle.patch({amount: {value: .95}});
// Call handle.dispose() when this material is removed, and system.dispose()
// when the host closes the collection of surfaces.
```

Graph construction, patches, evaluation and serialization remain available when
the host cannot create a WebGL2 context. A graphics-context failure is a renderer
capability failure; it does not change the saved material program.

## Source checks and package output

From a source checkout with dependencies installed:

```sh
node --conditions=browser --test tests/zones.test.mjs tests/resources.test.mjs tests/image-filter.test.mjs tests/filter-applications.test.mjs tests/pigment.test.mjs
npm run typecheck
npm run test:types
npm run build
npm run check:package
```

The full suite is `npm test`. Native driver checks, where Mesa EGL/GLES3 is
available, run with `python tools/validate-texturing-gpu.py validation/native`;
set `MOONWEAVE_NATIVE_SPECIMEN=shell` for the alternate specimen. They exercise
generated Three shaders and CPU/GPU field parity. They do not measure browser
frame rate.

The source ZIP contains these modules, examples and tests. The runtime tarball
contains bundled ESM, standalone declarations, exported graph examples and
selected documentation. [PACKAGING.md](PACKAGING.md) describes the reproducible
build and consumer check. [GRAMMAR.md](GRAMMAR.md) defines every operation;
`docs/VERIFICATION.md` in the source archive records the completed checks for the release.

### Shared reconstruction

Color and scalar channel readers with the same image, domain, address and
filter share one reconstruction. Channel selection projects its result. A
color reader plus three scalar readers therefore has a total read ceiling of
4, 8 or 64 according to its filter; changing image identity, domain, address or
filter creates a separate reconstruction. Footprint and tap configuration can
reduce actual reads, so filtered costs are ceilings rather than timing claims.
CPU evaluation shares the prepared result within one sample context.

Storage has a separate lifetime. One immutable image resource shares its
derived mip pyramid and one uploaded texture across its placements and
material handles. Replacing its numeric descriptor also replaces its derived
mips, while a domain or filter change can reuse that image storage. These
identities keep authored data reusable without conflating independent spatial
applications.

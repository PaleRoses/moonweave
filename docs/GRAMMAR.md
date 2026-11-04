# Moonweave texture grammar

Moonweave describes a material as a finite, typed expression graph. Coordinates
produce fields; scalar fields control color and finish; color fields construct
surfaces. The painted-facet atlas is one source within that language. A procedural
material does not need a facet sample or a paint style.

This document describes implemented operations. It is not a MaterialX importer,
an OSL implementation, or a promise that every renderer supports every operation.

## Six sorts, one signature

`SURFACE_SIGNATURE` in `src/core/algebra.mts` defines six sorts and 26 operations. Every
operation declares its result sort, typed input ports, structural literals, and
editable values there. Types, reference traversal, document validation and value
patching derive from that table. CPU interpretation and shader emission implement
the same operations separately.

| Sort | Meaning at a sample | Producers |
| --- | --- | --- |
| `image` | Shared immutable numeric texels; independent of sample position | `image` |
| `domain` | Position, normal, coordinate differentials and optional pixel footprint | `transform` |
| `scalar` | One number and, in CPU sampling, its `dx` and `dy` | `constant`, `parameter`, `axis`, `facing`, `noise`, `ramp`, `add`, `multiply`, `complement`, `imageScalar` |
| `color` | Extended-range linear Rec.709 RGB coordinates | `color`, `colorMix`, `colorRamp`, `colorAdjust`, `imageColor` |
| `facets` | The original sampled pigment weights and authored slopes | `facets` |
| `surface` | Color, roughness, metalness, clearcoat, opacity and unresolved slopes | `material`, `paint`, `mix`, `channels`, `relief`, `bump`, `coat`, `deposit` |

A color is not a generic three-vector, and a surface is not a color. There are no
implicit conversions between those sorts. A mask is a scalar used by a mixing
operation, not another stored sort.

### Expression grammar

The notation below shows reference ports. Values such as matrices, colors and
seeds are ordinary serializable data, not executable callbacks. An omitted
domain means the sample's rest frame.

```text
Image   ::= image(resource)
Domain  ::= transform(matrix, Domain?)

Scalar  ::= constant(number) | parameter(number)
          | axis(axis, Domain?) | facing(direction, Domain?, absolute)
          | noise(seed, Domain?)
          | ramp(Scalar, low, high)
          | add(Scalar, Scalar) | multiply(Scalar, Scalar)
          | complement(Scalar)
          | imageScalar(Image, Domain?, address, channel, filter?)

Color   ::= color(linearRGB) | colorMix(Color, Color, Scalar, space)
          | colorRamp(Scalar, Color[], positions[], space, interpolation)
          | colorAdjust(Color, Scalar, Scalar, Scalar)
          | imageColor(Image, Domain?, address, filter?)
Facets  ::= facets(mapping, Domain?)

Surface ::= material(Color) | paint(Facets, style, PaletteMap)
          | mix(Surface, Surface, Scalar)
          | channels(Surface, ChannelMap)
          | relief(Surface, Scalar)
          | bump(Surface, Scalar)
          | coat(Surface, Color, Scalar)
          | deposit(Surface, Color, Scalar, AssociatedChannels?)

ChannelMap ::= finite map from
               roughness | metalness | clearcoat | opacity
               to Scalar
PaletteMap ::= complete map from base | shadow | light to Color
AssociatedChannels ::= optional (value: Scalar, coverage: Scalar) pairs
                       for roughness | metalness | clearcoat | opacity
```

Normalized graph documents are version 2. Version 1 is an import format: its
style-owned sRGB swatches become ordinary Color nodes before validation. `expressionGraph` permits any of the six
sorts at the output. `materialGraph`, `parseGraph`, and the Three renderer require
a `surface` output; `parseExpressionGraph` imports any expression root. The
output sort is inferred from the node, not duplicated in serialized metadata.
References must exist and match their port sorts. Cycles, callbacks and invalid
unreachable imported nodes are rejected at the graph boundary. Existing facet
documents retain their meaning. Flat recipes use explicit `migrateSurfaceRecipe`;
canonical recipes contain `{version:2, mapping, style, palette}`.

## A field is a complete program

Patterns can be authored, named, stored, patched and sampled before a material
exists. The same validator and graph representation serve fields and surfaces.

```js
import {
  scalar, named, expressionGraph, createFieldSampler,
  patchGraph, serializeGraph, parseExpressionGraph,
} from '@moonweave/surfaces/core';

const pattern = expressionGraph(named('pores', scalar.noise({seed: 17})));
const sample = createFieldSampler(pattern);
const first = sample({
  position: [.2, .3, .4], dx: [.01, 0, 0], dy: [0, .01, 0],
});
// first has value, dx and dy. No surface or renderer is constructed.
const revised = patchGraph(pattern, {pores: {seed: 29}});
const restored = parseExpressionGraph(serializeGraph(revised));
const revisedSample = createFieldSampler(restored);
```

`createFieldSampler` prepares a scalar, color or domain interpretation once and
returns a function of the sampling context. Each call has fresh memoized sample
values; a shared child evaluates at most once in that call. A sampler belongs to
the immutable graph revision from which it was created. Create another sampler
for a patched graph. Facet and Surface roots can be stored and folded, but are
explicitly rejected by this CPU sampler because atlas/lighting interpretation
is outside its supported algebra.

`graphExpression(graph, rootId?)` converts a validated graph or graph document
back into owned expression data. The default root retains its sort in TypeScript;
an explicit root ID or an unknown imported document returns the expression union.
Check a parsed root's kind before passing it to a constructor that expects a
particular sort:

```js
import {graphExpression, instantiate, surface, color} from '@moonweave/surfaces/core';

const storedPattern = parseExpressionGraph(serializeGraph(pattern));
const pores = graphExpression(storedPattern);
if (pores.kind !== 'noise') throw new TypeError('Expected the saved noise field.');
const localPores = instantiate(pores, {prefix: 'wing'});
const detailed = surface.bump(surface.material(color.srgb('#b5d5c4')),
  scalar.multiply(.025, localPores));
```

Every stored graph ID becomes an expression ID. Shared children remain shared,
including when extracted separately with `graphExpression(graph, childId)`.
Repeated extraction from one validated graph returns the same owned object;
patched revisions have independent caches. These recovered expressions can be
used as explicit `shared` inputs. The complete input document is validated,
but only definitions reachable from the selected root enter the expression.
Consequently, converting that expression back to a graph preserves its reachable
document and omits valid unused imported definitions. Keep the original graph
when those definitions should remain in the saved document.

`foldGraph` interprets a root through typed handlers. This is the core extension
boundary: an operation's data and ports belong to the signature; each backend
supplies its meaning. An algebra missing a reachable operation fails explicitly.

## Construct a material without the atlas

```js
import {
  scalar, color, domain, surface, named, materialGraph, compileGraph,
} from '@moonweave/surfaces/core';

const coordinates = domain.transform([
  3, 0, 0, 0,
  0, 3, 0, 0,
  0, 0, 3, 0,
  0, 0, 0, 1,
]);
const grain = named('grain', scalar.noise({seed: 41, domain: coordinates}));
const pigment = named('pigment', color.mix(
  named('shadow', color.srgb('#284d58')),
  named('light', color.srgb('#b5d5c4')),
  scalar.ramp(grain, .25, .75),
));
const material = surface.channels(surface.material(pigment), {
  roughness: scalar.add(.28, scalar.multiply(.42, grain)),
});
const graph = materialGraph(material);
const plan = compileGraph(graph);

// The same noise result drives pigment and roughness.
// plan.cost.proceduralSamples === 1
// plan.cost.paintSamples === 0
// plan.cost.textureReads === 0
```

`surface.material(color)` projects color components to `[0,1]` at the reflectance
boundary. It starts with zero slope, roughness `0.5`, metalness `0`,
clearcoat `0` and opacity `1`. Existing `surface.channels` supplies scalar finish
fields. Existing `surface.mix` can combine this surface with a painted facet
surface using any scalar mask.

The host adapter acquires paint atlases only when the live compiled graph uses
facets. Adding a facet branch later acquires the shared resources then. Graph
construction, parsing, patching, compilation and CPU field evaluation remain
independent of the DOM, Three.js and texture allocation.

## Scalar noise has a specified meaning

`scalar.noise({seed = 0, domain})` is one octave of three-dimensional quintic
value noise. It interpolates deterministic values at the eight surrounding
lattice corners. Each interpolation axis uses

```text
f(t)  = 6t^5 - 15t^4 + 10t^3
f'(t) = 30t^2(t - 1)^2
```

The corner hash uses uint32 arithmetic; `seed` is an integer from `0` through
`4294967295`. The lattice repeats every 65,536 units on each axis. Values lie in
`[0,1]`. The CPU returns analytic spatial derivatives propagated through the
sample's domain differentials. The GPU uses the same corner/hash construction;
interpolation uses float32 there and JavaScript number precision on the CPU, so
the two are numerically close at representable coordinates rather than bit-identical.
Large-magnitude coordinates can lose fractional or whole-cell detail when rounded
to float32, producing a different sample rather than a small interpolation error.
Recenter or rescale such domains before evaluating them; a large allowed numeric
range is not a promise of uniform spatial precision.

The node has no duplicate frequency, scale, contrast, amplitude or octave
controls. Use a domain transform for scale/rotation/translation, scalar
arithmetic for amplitude and offset, and `ramp` for thresholds. Those operations
can be shared with other parts of a material.

This is **point sampling**, not a filtered pixel average. Derivatives describe
local variation; they do not remove frequencies above the sampling limit.
High-frequency noise, nonlinear thresholds and sums of octaves can alias. There
is no implicit fBM loop or claim of automatic noise filtering. The Three adapter
limits a shader to 16 live noise nodes, alongside its existing limits of eight
facet samples and 16 paint styles. `plan.cost.proceduralSamples` reports live
noise evaluations independently of texture reads.

## Color space and interpolation

`color.linear([r,g,b])` stores editable extended-range linear Rec.709 RGB
coordinates. Authored components must be finite and within `±1e20`. Intermediate
color values may be negative or exceed one. Color coordinates and physical
reflectance are distinct: interpolating two in-gamut colors in Oklab can produce
an out-of-gamut color, which remains available for further composition.

`surface.material(color)` clamps its final color to `[0,1]`. Explicit color
fields connected to a paint palette are clamped before the original pigment
kernel. This is a declared reflectance projection, **not perceptual gamut
mapping**; clipping can alter hue. The legacy pigment kernel and its artistic
grain gain remain unchanged. Color fields do not add HDR emission, alpha
compositing, spectral transport or a physical pigment-mixing model.

`color.srgb('#rrggbb')` converts a six-digit sRGB hex value once, before it enters
the graph. Its stored node is the same `color` kind as `color.linear`. Palette
colors in the original paint path use the same conversion function.

For a scalar mask `m`, color mixing is pointwise:

```text
w = clamp(m, 0, 1)
C = (1 - w) A + w B
```

The default interpolation happens in linear RGB. `color.mix(black, white, .5)` therefore
returns linear `0.5`; it does not return the linear decoding of sRGB `#808080`
(approximately `0.215861`). Display encoding belongs to the renderer.

`color.mix(a, b, mask, {space: 'oklab'})` converts both inputs to Oklab,
interpolates there, and returns extended linear RGB. The conversion uses signed
cube roots and the D65 coefficients documented by CSS Color 4. One matrix table
supplies both CPU evaluation and generated GLSL; there are no independent
rounded CPU/GPU coefficient copies. Omitted space means `'linear-rgb'` and
retains the legacy serialized form.

For a conversion `T`, the perceptual mixture is

```text
C = T⁻¹((1 - w) T(A) + w T(B))
```

The CPU applies the Jacobian of each conversion and the complete mixture
product rule. At a zero LMS component the cube-root derivative is singular.
A zero tangent uses the declared zero-tangent convention; a nonzero tangent
raises an explicit derivative error. This does not reconstruct higher-order
behavior at a singularity. Endpoints return the selected child exactly without
a color-space round trip. CPU and GPU use different arithmetic precision and
are compared numerically rather than claimed to be bit-identical.

`evaluateColor(graph, id, context)` samples a color subgraph without a renderer.
It returns immutable `{value, dx, dy}` triples. For `0 < m < 1`, its differential
uses the product rule:

```text
dC = (1 - w) dA + w dB + (B - A) dm
```

The derivative of the clamped mask is zero at and outside its endpoints. Color
inputs can still vary there: at weight zero the result follows `A`, and at one
it follows `B`. CPU sampling first selects the mask branch; an unused branch is
not sampled. Reusing exactly the same color bypasses the mask entirely.

```js
import {scalar, color, surface, named, materialGraph, evaluateColor}
  from '@moonweave/surfaces/core';

const gradient = named('gradient', color.mix(
  color.linear([0, 0, 0]),
  color.linear([1, 1, 1]),
  scalar.ramp(scalar.axis('x'), 0, 1),
));
const graph = materialGraph(surface.material(gradient));
const sample = evaluateColor(graph, 'gradient', {
  position: [.5, 0, 0], dx: [.01, 0, 0], dy: [0, .01, 0],
});
// sample.value: [.5, .5, .5]
// sample.dx:    [.015, .015, .015]
// sample.dy:    [0, 0, 0]
```

## Related pigments are a color action

`color.oklab([L,a,b])` and `color.oklch([L,C,hDegrees])` convert authoring
coordinates once to the existing editable linear-RGB literal. OKLCH chroma is
nonnegative; hue uses degrees. They do not create another runtime color type.

`color.adjust(input, {lightness = 0, chroma = 1, hue = 0})` is one Color operation.
Each control accepts a number or Scalar expression. Lightness is an **offset**,
chroma a **multiplier**, and hue a rotation in **degrees**. The action runs in
Cartesian Oklab, avoiding extraction of an undefined hue at the neutral axis.
Write `z = a + ib` and convert degrees to radians for the exponential:

```text
A(ℓ, c, θ)(L, z) = (L + ℓ, c exp(iθ) z)
A(ℓ₂,c₂,θ₂) ∘ A(ℓ₁,c₁,θ₁) = A(ℓ₁+ℓ₂, c₁c₂, θ₁+θ₂)
identity = (0, 1, 0)
```

This is a real-number composition law, not permission to reorder floating-point
programs. A zero chroma multiplier is noninvertible. A negative multiplier is
valid and is equivalent mathematically to a positive multiplier with another
180° rotation. Nested nonidentity adjustments retain authored evaluation order.
The compiler folds an adjustment only when its controls are literal identity
values, including periodic hue. Parameters currently at identity remain live.

```js
const pigment = named('pigment', color.oklch([.62, .08, 220]));
const shadow = color.adjust(pigment, {lightness: -.18, chroma: .65, hue: 12});
const highlight = color.adjust(pigment, {lightness: .22, chroma: .35, hue: -18});
const accent = color.adjust(pigment, {
  hue: named('accentHue', scalar.parameter(155)),
});
```

The normalized graph has `input`, `lightness`, `chroma`, and `hue` reference
ports. Parameters can be shared with another adjustment or can be spatial
fields. No color value is clamped during the action; reflectance projection
stays at the material boundary. This operation is neither physical pigment
mixing nor a display transform.

For `u=(a,b)`, rotation matrix `R`, and 90° rotation `J`, the CPU propagates
both supported directional derivatives with the full product rule:

```text
D L′ = D L + D ℓ
D u′ = (D c) R u + c R (D u) + c (D θ) R J u
```

The hue derivative includes the factor `π/180`. CPU and GLSL reduce hue by
`h - 360 floor((h + 180)/360)` before applying sin/cos. This periodic action
has a continuous derivative through the angle wrap; very large angles still
lose precision in finite arithmetic. The Oklab zero-LMS derivative convention
above applies here as well. Extreme composed fields can overflow GPU float
arithmetic; finite input validation is not a promise that arbitrary expressions
remain bounded.

## Coverage is ordinary scalar composition

`mask.interval(input, low, high, {feather})` has finite support and smooth inward
edges. Feather is in the input's units and defaults to one tenth of the interval
width. It must be positive and no greater than half the width. The generated
ramp edges must satisfy the existing float32 representability contract.

```text
W(x; l,h,e) = ramp(x,l,l+e) × (1 − ramp(x,h−e,h))
```

The value is zero at and outside the interval, one between the two feathered
edges, and C1 at the joins. `mask.chisel({domain, feather})` multiplies one such
window per axis on local `[-1,1]³`. Feather defaults to `.2` local units and
accepts a single width or three axis widths. Domain transforms place, rotate
and stretch the coverage. Both helpers return ordinary Scalar expressions;
there is no mask sort, new shader instruction, texture resource or callback.

```js
const coverage = mask.chisel({feather: [.15, .55, .2]});
const colored = color.mix(pigment, accent, coverage, {space: 'oklab'});
const painted = surface.paint('carapace', {palette: {base: colored}});
```

Coverage controls color here. It changes neither the original authored slopes
nor the style's finish. Connect coverage to `surface.channels` or to a height
expression only when that relationship is intended. These are bounded implicit
3D stamps, not signed distance fields or brush paths. Smooth point samples do
not guarantee antialiasing at distant views. Hundreds of separately expanded
stamps need a different resource/batching representation, rather than unbounded
shader growth. [COLOR-STUDY.md](COLOR-STUDY.md) records the research and remaining
art-direction requirements.

## A color ramp is one typed operation

```js
const palette = named('bodyPalette', color.ramp(grain, [
  [.1, named('ink', color.srgb('#253b52'))],
  [.4, named('teal', color.srgb('#649b9b'))],
  [.7, named('pearl', color.srgb('#d7ddc8'))],
  [.9, named('rose', color.srgb('#a38ba5'))],
], {space: 'oklab', interpolation: 'smoothstep'}));
```

The stored node has one scalar input, a typed list of color references, an
editable list of positions, and structural `space`/`interpolation` choices.
It supports 2–16 stops. Positions may extend outside `[0,1]`; they must be
strictly increasing, distinct after float32 conversion, and separated by at
least `1e-6`. Invalid or sparse lists fail validation. Positions are not sorted
silently, and repeated positions are not used to encode ambiguous steps.

For an interval `[pᵢ,pᵢ₊₁]`, let `t = (x-pᵢ)/(pᵢ₊₁-pᵢ)`. Interpolation is
`t` for `'linear'`, `t²(3-2t)` for `'smoothstep'`, and the left color for
`'constant'`. Outside the stop range the nearest endpoint color is returned.
At an exact knot, the authored stop is returned exactly; constant ramps are
right-continuous. At knots the input-derived tangent is defined as zero while
the selected color's own tangents remain. Linear/constant ramps need not have a
classical derivative at those knots, so this is an explicit convention.

CPU interval lookup uses binary search and samples only the selected color or
pair. The shader keeps upstream field sampling outside its selection branches
so derivative-dependent texture sampling is well-defined. It evaluates one
color mixture for the selected interval; it does not promise to skip every
upstream field in unused stops.

Changing positions or color values retains the compiled structure. Changing
the stop count, reference connections, space or interpolation changes the
program. The generic typed-list port is also used by traversal, domain binding,
folds and graph validation; the editor does not maintain another ramp format.

## The original paint accepts color fields

```js
const painted = surface.paint('carapace', {
  palette: {
    base: palette,
    shadow: color.mix(color.srgb('#152b40'), palette, .3, {space: 'oklab'}),
    light: color.mix(palette, color.srgb('#ecdfb9'), .7, {space: 'oklab'}),
  },
});
```

For an explicitly shared facet field, use
`surface.paint(field, style, {base: palette})`. Authoring fills omitted roles
from the selected preset once, producing three required Color references.
`style` contains only numeric controls. Every literal uses the ordinary `color`
node and its value binding; the renderer has no fallback palette path.
The field sampling and pigment/relief kernel are otherwise unchanged. One color
field can feed several pigment roles and several surfaces without adding atlas
reads. `surface.mix` continues to mix material parameters; choosing Oklab for a
palette does not change the meaning of surface mixing.

## Composition and laws

These laws describe existing representations and permitted simplifications;
they do not authorize arbitrary real-number rewrites of floating-point code.

| Law or property | Contract |
| --- | --- |
| `color.mix(c,c,m) = c` | Shared identical color references can eliminate the mix. |
| `color.mix(a,b,k) = a` for literal `k ≤ 0` | Literal endpoint masks can remove the unused branch. |
| `color.mix(a,b,k) = b` for literal `k ≥ 1` | The corresponding upper endpoint rule. |
| A ramp whose stops all reference `c` equals `c` | Remove the selector and stop-position work; retain `c`'s editable binding. |
| `channels(channels(s,A),B) = channels(s,A ⊕ B)` | Later values win in the finite channel map; the empty map is the identity. |
| `inDomain(e, undefined) = e` | The exact original expression object is returned. |
| Coordinate-free expressions remain shared | Domain binding leaves color values and scalar parameters unchanged. |
| `bump(s, h)` adds the differential of `h` | Height arithmetic, including varying masks, is evaluated before differentiation. |
| A reused expression is evaluated once per sample | Reference sharing is preserved through lowering and typed folds. |
| Reference mapping preserves identity and composition | Traversal changes typed references without changing their payloads. |

Editable colors and seeds remain live values. Equal-valued, independently
editable color nodes are not merged. A scalar parameter currently equal to zero
or one is not treated as a structural literal. Value patches retain unchanged
nodes and graph identity for no-op edits; a failed patch publishes no partial
graph.

Addition and multiplication keep their authored grouping. Domain transform
chains keep their order. The compiler does not assume associativity over
floating-point values, and it does not erase `1 - (1 - x)` merely because that is
a real-number identity.

Surface mixing still interpolates material parameters and authored slopes. It
is not a layered BSDF. In particular, mixing slopes is not the derivative of a
mixed height field: that would also require the derivative of the mask and the
two height values. `relief` remains slope scaling, not displacement.

## Height fields produce composable surface detail

```js
const height = scalar.multiply(
  named('depth', scalar.parameter(.035)),
  scalar.multiply(region, grain),
);
const detailed = surface.bump(painted, height);
```

`bump : Surface × Scalar → Surface` adds `D(height)` to the input surface's
unresolved slope pair. Color and finish are inherited. Height amplitude and
masking use the existing scalar algebra; the operation adds no separate scale
uniform, resource type, atlas or stored normal vector.

For a first differential `D = (∂/∂x, ∂/∂y)`, the interpreter uses

```text
D(a + b) = Da + Db
D(a b)   = b Da + a Db
D(f(a))  = f'(a) Da
bump(s,h).slope = s.slope + Dh
```

In particular, `D(mask × height) = mask × Dheight + height × Dmask`.
Multiplying a completed slope by a mask, as `relief` does, has different
semantics. A stack of bump operations accumulates unresolved slopes and uses
the existing final surface-gradient normal resolve once. This is shading
detail; it does not change geometry, silhouette, occlusion or a shadow mesh.

The GPU compiler requests analytic first differentials only for scalar and
domain ancestors needed by live bump heights. Interpolated rest positions and
normals supply initial screen tangents via GPU derivatives. Affine coordinates,
normal normalization, scalar arithmetic, ramps and noise then propagate those
tangents with their chain rules. Noise obtains its value and spatial gradient
from the same eight lattice corners. The completed nonlinear height is not
resampled at offset positions or differentiated by a final `dFdx(height)`.

The CPU scalar sampler is the reference interpretation. Derivative directions
do not imply footprint filtering. Filtered image readers consume an independent
pixel footprint and return partials with that footprint held fixed. Procedural
noise and analytic masks retain their point-sampling semantics. The GPU's initial
interpolation tangents still have rasterization and float32 limits. Absolute facing uses a
zero derivative at its cusp; ramp endpoints use their documented zero tangent.
No algebraic rewrite may rearrange an authored floating-point sum merely from
the real-number linearity of differentiation.

## Reusable functions are ordinary JavaScript

A reusable material function accepts typed expressions and returns a typed
expression. It runs while constructing the graph; it is not serialized as a
callback or executed by a renderer.

```js
export function mottled({field, dark, light, roughness = .5}) {
  return surface.channels(
    surface.material(color.mix(dark, light, field)),
    {roughness},
  );
}

const skin = mottled({
  field: scalar.noise({seed: 7}),
  dark: color.srgb('#52413f'),
  light: color.srgb('#a78970'),
  roughness: scalar.parameter(.65),
});
```

Pass the same expression when edits should be shared. Call the constructor
again when values should be independently editable. `named` supplies explicit
patch IDs; functions instantiated more than once should use caller-supplied
names or leave their local nodes unnamed to avoid duplicate IDs.

### Explicit local instances and shared inputs

`instantiate(expression, {prefix, shared})` copies an expression with its sort
and internal reference sharing intact. Every local node gets independent
identity; authored IDs receive the caller's prefix. Expressions listed in
`shared` are borrowed intact, including their descendants. This makes the edit
ownership of a reusable template explicit without a second group-node format.
Each shared root must be Moonweave-owned. Constructors, `named` and
`graphExpression` establish that immutable ownership; a no-op
`inDomain(rawExpression, undefined)` does not acquire ownership of raw data.
Raw local templates are snapshotted, but raw shared roots are rejected: copying
the same mutable object in separate calls cannot preserve one immutable shared
identity. To reuse raw expression data, call `named(id, rawExpression)` once,
then use that returned expression in the template and every `shared` list.

```js
const finish = named('sharedFinish', scalar.parameter(.55));
const template = surface.channels(
  surface.bump(surface.paint('carapace'),
    scalar.multiply(named('depth', scalar.parameter(.025)), grain)),
  {roughness: finish},
);
const left = instantiate(inDomain(template, leftFrame), {
  prefix: 'left', shared: [finish],
});
const right = instantiate(inDomain(template, rightFrame), {
  prefix: 'right', shared: [finish],
});
```

The local depths can be patched independently while `sharedFinish` remains one
shared control. Prefixes are deterministic and full resulting IDs must satisfy
the existing ID rules. The helper does not silently fix two instances that
reuse the same prefix. Coordinate binding remains its own explicit operation;
`shared` controls instantiation ownership, not a new coordinate-locking rule.

## Capability boundary

| Capability | Implemented now | Remaining boundary |
| --- | --- | --- |
| Procedural 3D masks | Seeded value noise, position/facing, scalar arithmetic and smooth ramps | No automatic footprint filtering or higher-level noise families |
| Independent color fields | Extended linear RGB, explicit linear/Oklab mixing, multi-stop ramps and CPU differentials | No perceptual gamut mapping, spectral values or HDR emission |
| Generic material construction | Color, scalar finish fields and additive scalar-height detail, with no required atlas | No geometry displacement or physical layer closure algebra |
| Coordinate reuse | Ordered affine domains, whole-expression domain binding | Planar image sampling implemented; no generic vector field or nonlinear domain warp |
| Existing painted appearance | Original atlas sampling, typed palette fields, paint styles, authored slopes and composition | No CPU atlas/lighting interpreter |
| Reusable npm functions | Any-sort graph roots, direct field samplers, ordinary JS/TS functions and explicitly scoped instances | No serialized function/module invocation system |
| Resource ownership | Pure graph data; renderer adapter owns materials and borrows/acquires textures | Embedded image ownership implemented; no external resolver, asynchronous asset graph or general baking/export pipeline |
| Image filtering | Explicit linear, trilinear and bounded eight-tap anisotropic reconstruction; clamp, repeat and zero extension | No EWA or exact whole-material pixel integral; CPU footprints are explicit |

The next grammar extension should be justified by a concrete material that
cannot be expressed with these operations, and should add its type, sampling
semantics, resource needs and backend support together.

## Primary references and adopted boundaries

- [Mikkelsen, Surface Gradient–Based Bump Mapping Framework](https://jcgt.org/published/0009/03/04/):
  accumulate unresolved surface detail and resolve the shading normal after
  composition. Moonweave uses its existing slope representation and adds a
  scalar-height bridge rather than introducing a competing normal representation.
- [OSL derivatives and area operators](https://open-shading-language.readthedocs.io/en/latest/stdlib.html#derivatives-and-area-operators):
  sampling differentials have an explicit evaluation context; derivatives and
  filtering are separate capabilities.

- [CSS Color 4, 3 November 2026 draft](https://www.w3.org/TR/2026/CRD-css-color-4-20261103/):
  preserve extended color coordinates during interpolation, select the working
  interpolation space explicitly, and use its D65/Oklab conversion coefficients.
- [Color.js interpolation](https://colorjs.io/docs/interpolation) and
  [gamut mapping](https://colorjs.io/docs/gamut-mapping.html): interpolation
  progression, interpolation space and lossy gamut mapping are separate concerns.
- [Culori interpolation](https://github.com/evercoder/culori/blob/main/src/interpolate/interpolate.js):
  stop placement and channel interpolation are distinct inputs to a transfer function.

- [MaterialX specification](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.Specification.md):
  explicit port types, color-space conversion before computation, and the
  distinction between a node's interface and its implementation. Moonweave uses
  a small typed signature and explicit linear color rather than implying
  MaterialX compatibility.
- [MaterialX standard nodes](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.StandardNodes.md):
  separates procedural coordinates, noise, operators and color mixing. This
  supports keeping transforms and scalar arithmetic outside Moonweave's noise
  primitive.
- [PBRT texture interfaces](https://www.pbr-book.org/4ed/Textures_and_Materials/Texture_Interface_and_Basic_Textures):
  material inputs use the same texture interface for constant and varying
  values. Moonweave likewise accepts scalar fields for finish and color fields
  for material construction.
- [PBRT texture filtering](https://www.pbr-book.org/4ed/Textures_and_Materials/Texture_Sampling_and_Antialiasing):
  texture footprints describe the sampling rate; filtering must remove
  unsupported frequencies. This is why analytic derivatives are not presented
  as automatic antialiasing.
- [OSL standard library](https://open-shading-language.readthedocs.io/en/v1.13.12.0/stdlib.html):
  noise varieties differ in output range and filtering behavior. Moonweave
  names its precise value-noise and point-sampling contract rather than
  treating all noise as interchangeable.
- [Blender fields](https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/fields.html):
  a field is evaluated in a context; sharing its definition does not mean
  caching its value across different contexts. Moonweave memoizes within a
  sample and starts fresh sample state for each evaluation.
- [Three.js Shading Language](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language):
  reusable expression functions and separate graph construction, analysis and
  generation. Moonweave's JS factories compose the existing grammar; adding a
  second serialized execution language is unnecessary for this form of reuse.
- [Hash Functions for GPU Rendering](https://jcgt.org/published/0009/03/02/):
  the noise kernel uses PCG integer hashing rather than a transcendental
  floating-point hash. Its interpolation and CPU/GPU tolerances are tested
  separately from its repeatable integer corner values.

## Embedded Image resources and typed readers

An `image` node has no reference ports and one editable `resource` value:

```js
{width: 32, height: 32, channels: 1, data: [/* row-major float32 samples */]}
```

Widths and heights are integers in `[1,4096]`; channels are one or three. Data starts at the lower-left texel. The ownership boundary copies ordinary arrays or Float32Array input, rounds each value once to float32, and freezes ordinary arrays suitable for JSON. Graphs allow at most 262,144 image components in total, 256 nodes and depth 64. The JSON import budget is 16 MiB; the same component budget applies to persistent resource edits.

`image.generate(shape, callback)` tabulates texel centers `(u,v,x,y)` once and discards the callback. Its result is an Image expression, not executable content. `scalar.image` and `color.image` take an Image reference and optional Domain. Their coordinate is the domain's `position.xy`; a supplied affine frame uses the existing point/differential rules. Color readers interpret RGB as linear Rec.709. Scalar readers select `r`, `g` or `b`; one-channel images repeat their value into RGB. Display encoding and alpha interpretation are not implicit.

For a cell with corners `a,b,c,d`, local fractions `s,t`, width `w` and height `h`:

```text
F    = (1-t) ((1-s)a + s b) + t ((1-s)c + s d)
dFdu = w ((1-t)(b-a) + t(d-c))
dFdv = h ((1-s)(c-a) + s(d-b))
DxF  = dFdu * Dxu + dFdv * Dxv
DyF  = dFdu * Dyu + dFdv * Dyv
```

Texel centers are `(i+.5)/size`. `clamp` extends edge texels; derivatives in the extended direction vanish. `repeat` wraps indices and interpolates across the seam. `zero` assigns zero to out-of-image texels, with finite tent support and matching partials. At an exact cell knot, floor selects the right/upper cell, including a zero derivative at the last clamped center. Values are continuous; derivatives are piecewise and generally discontinuous at knots.

An omitted `filter`, or `linear`, means the original base-level bilinear reconstruction. `trilinear` blends mip levels selected from the pixel footprint. `anisotropic` averages at most eight trilinear taps along its major axis. The CPU's optional `SampleContext.footprint = {dx,dy}` is separate from the derivative directions; affine domains transport it. The GPU derives the footprint from unwrapped domain screen tangents. Returned partials hold footprint and filter decisions fixed. No footprint means a point sample. Zero-extended finite marks use virtual coarse levels so subpixel coverage continues to fade. [FILTERING.md](FILTERING.md) specifies reduction, footprint equations, boundaries and approximation limits.

Color and scalar readers of the same image, domain, address and filter share one reconstruction. Their channel projections remain distinct typed nodes. Editable image or domain identities are never merged merely because their current values match. The CPU shares prepared sample functions with weak caches and computes each shared sample once per evaluation context.

The GPU uses explicit high-precision nearest float reads: a ceiling of four for linear, eight for trilinear and 64 for anisotropic reconstruction. Derived area-average mipmaps are shared by owned resource identity, uploaded once, and excluded from graph JSON. Resource bytes are editable; width, height and channel changes retain the compiled program and update texture/size bindings. Coordinate connections, address mode, filter and channel selection are structural. One normalized resource identity is reference-counted across material handles. Removing its final live reference disposes its texture. Dead uniform slots release references to previous image revisions.

## Named zone applications

`zone(name, coverage, effects)` is an immutable authoring record. Its coverage is an ordinary named Scalar expression, with the precondition `0 <= coverage <= 1`; its name survives graph serialization and instance prefixes. `applyZones(surface, zones)` folds an ordered list and lowers into existing expression constructors. No Zone opcode, callback or second runtime is stored.

The soft coverage algebra is:

```text
intersect(a,b) = a*b
union(a,b)    = a+(1-a)*b
subtract(a,b) = a*(1-b)
complement(a) = 1-a
```

The union form avoids subtracting two nearly equal numbers when one input is tiny. Intersection and union are commutative and associative over the reals, with identities one and zero respectively. They are not idempotent on fractional coverage. Floating-point evaluation preserves the authored order.

A zone's effects apply in this order:

1. `coat(surface, color, coverage)` changes only pigment color. It clamps its color target and weight to reflectance/coverage bounds; finish, opacity and existing slope remain untouched.
2. `mix(surface, channels(surface, values), coverage)` interpolates the listed finish targets. Both branches share the same input surface; unspecified channels survive.
3. `bump(surface, coverage * height)` adds the complete differential `D(mh) = m Dh + h Dm`.

The last rule is not `coverage * D(height)`. A uniform deposit still creates a slope at the zone boundary. Earlier slopes are preserved. Zone order matters for overlapping pigment and finish targets; height contributions add in authored order. `applyZones(s, [])` is identity, and applying concatenated lists has the same structural expression as successive applications. Literal-zero coverage specializes away; a live parameter at zero retains its editable effects.

## Spectral authoring quantities

The optional `pigment` namespace uses the attributed Spectral.js 3.0.0 basis and 38 wavelengths from 380 to 750 nm. It is an authoring algebra; spectral state is projected into a Color literal or tabulated Image before graph runtime.

A quantity stores concentration `C` and weighted moments `M[i] = sum(Cj * KSj[i])`. Addition combines these arrays componentwise; nonnegative scaling multiplies both `C` and `M`. The empty quantity `(0,0)` is the additive identity and has no projectable color. These laws are real-arithmetic properties, checked with floating-point tolerances. The convenience `pigment.mix(a,b,t)` uses upstream squared factors `(1-t)^2` and `t^2` and is not associative.

A leaf's effective concentration includes squared tinting strength and D65 luminance. Reflectances use `KS=(1-R)^2/(2R)`; zero reflectance is regularized to Number.EPSILON. The inverse is evaluated in rationalized form `R=1/(1+KS+sqrt(KS*KS+2*KS))`, avoiding catastrophic cancellation for dark values. Projection integrates the D65-weighted tables and transforms XYZ into extended linear RGB. It does not perform perceptual gamut mapping.

The complete MIT notice and upstream provenance accompany the copied/adapted basis tables. RGB palette tables approximate the spectral curve between their samples; `docs/history/0.55/applications55.json` in the source archive measures that approximation separately from CPU/GPU reconstruction error. See [APPLICATIONS.md](APPLICATIONS.md) for the full executable authoring path.


## Associated deposition and portable mark programs

`surface.deposit(input, associatedColor, coverage, channels?)` is one surface
operation. For valid associated pigment `0 ≤ p ≤ a ≤ 1`, it observes
`color = p + (1-a)*input.color`. At the material boundary it uses
`a = clamp(coverage,0,1)` and componentwise `p = clamp(associatedColor,0,a)`.
Each optional finish channel has its own `{value, coverage}` pair and the same
source-over equation. A missing channel preserves the original component. The
operation preserves slope; covered thickness/depth feeds `surface.bump` directly.
Graph documents require each optional value/mask pair together. Opacity interval
analysis includes both endpoint extrema and the interior coverage maximum.

This representation keeps the correlation of color and coverage through filtering:
`F(a*c)` is stored, rather than reconstructed as `F(a)*F(c)`. There is no division
at transparent edges. Ordered mark programs bake all contributions at shared
quadrature samples; their expanded dabs and spatial bins are authoring artifacts,
not runtime graph nodes. [MARKS.md](MARKS.md) defines the program grammar,
placement/pressure/spacing contract, independent finish masks and budgets.

The existing exact effect optimizer treats a deposit as a source surface atom.
It preserves its identity and verifies operations around it; it does not reorder
or fuse deposited layers or claim real-number associativity for their floats.

[COLOR.md](COLOR.md) defines tagged inputs, extended working coordinates and
explicit SDR gamut mapping. The graph itself still has one Color representation.

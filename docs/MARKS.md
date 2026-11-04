# Painterly mark programs

A mark program is immutable authoring data: named brush resources, optional
finite image zones, and an ordered sequence of affine dabs or pressure paths.
Compilation expands paths once. Baking resolves image footprints and spatial
bins, then jointly accumulates pigment, coverage, independent finish channels
and covered height. The result lowers to the ordinary typed surface graph.

There is no interactive canvas state, mutable second graph, callback in saved
JSON, renderer dependency, or process-wide mark cache. The caller owns a compiled
program when it needs repeated bakes; a final graph owns the baked float images.

## A complete application

```ts
import {
  applyMarkBake, bakeMarks, color, displayColor, image, markProgram,
  materialGraph, surface, toWorkingColor,
} from '@moonweave/surfaces/core';

const tip = image.generate({width: 32, height: 32, channels: 1}, (u, v) => {
  const radius = Math.hypot((u - .5) * 2, (v - .5) * 2);
  return Math.max(0, 1 - radius) * (.8 + .2 * Math.cos(v * 80));
}).resource;

// The explicit display boundary selects unit-range linear reflectance.
const cobalt = toWorkingColor(displayColor({
  space: 'oklch', coords: [.53, .13, 245],
}, 'srgb'));

const program = markProgram({
  brushes: {bristle: {mask: tip, filter: 'anisotropic'}},
  marks: [{
    kind: 'stroke', brush: 'bristle', color: cobalt,
    points: [
      {at: [-.7, -.5], pressure: .25},
      {at: [-.2, .1], pressure: 1},
      {at: [.55, .8], pressure: .4},
    ],
    radius: .16, aspect: .5, spacing: .4, opacity: .7,
    height: .004, channels: {roughness: .74, metalness: .02},
  }],
});

const bake = bakeMarks(program, {
  width: 128, height: 128, bounds: [-1.2, -1.2, 1.2, 1.2], samples: 2,
});
const graph = materialGraph(applyMarkBake(surface.paint('carapace'), bake));
```

The source repository includes a complete 21-mark study in
`lab/mark-examples.mts`. `carapaceMarkProgram()` returns its portable brush/zone/path
program; `paintedCarapace()` returns its final material graph. The build exports
the reusable source program as `examples/marks.program.json`.

## The program grammar

| Element | Required data | Defaults / meaning |
| --- | --- | --- |
| Brush | `mask` | One-channel numeric image; `filter` defaults to `anisotropic` |
| Zone | `mask` | Optional forward `transform`; identity by default; same filtering contract as brushes |
| Dab | `kind:'dab'`, `brush`, `transform`, `color` | Places a brush's unit UV square on the program plane |
| Stroke | `kind:'stroke'`, `brush`, `points`, `radius`, `color` | Distance-spaced dabs along a polyline |
| Point | `at:[x,y]` | `pressure:1`; pressure scales radius and dab coverage |
| Mark style | `color` | `opacity:1`, `height:0`; optional independent finish targets and zone name |

Colors are linear Rec.709 reflectance triples in [0,1]. Extended working colors
remain valid in the color algebra, but the mark pigment boundary requires an
explicit in-gamut choice. See [COLOR.md](COLOR.md). This avoids implicitly
clipping a composite of several out-of-gamut pigments in an order-dependent way.

Brush and zone resources have one channel with coverage in [0,1]. They use zero
extension, including the existing finite bilinear support and virtual coarse
levels. Brush names and zone names follow the graph's identifier rules. Marks
reference these names rather than copying a brush into every dab.

`markProgram` snapshots caller-owned arrays and objects. A local normalization
map preserves a raw resource shared by brushes and zones; already-normalized
image data retains its existing identity. It does not freeze the caller's data.
The returned program and its owned descendants are frozen.

Passing that canonical program through `markProgram`, `compileMarkProgram` or
serialization borrows the same validated record; its image samples are not
validated again. A frozen caller-created record still crosses the ordinary
normalization boundary. Sparse colors, transforms, mark lists and paths are
rejected there rather than reaching expansion with missing values.

### Placement and stroke controls

All mark transforms use six coefficients `[a,b,c,d,e,f]`, with the forward map

\[
(u,v) \mapsto (au+cv+e,\;bu+dv+f).
\]

For a dab this maps the brush's `[0,1]²` image to the program plane. For a stroke
it transforms the complete path and brush footprints after local placement.
Shear, reflection, nonuniform scale, rotation and translation are supported.
The map and its inverse must remain finite and invertible.

A stroke's `spacing` is measured in base-radius units and defaults to 0.35.
It does not depend on vertex count, event timing or pointer speed. `aspect`
defaults to 1 and scales the radius perpendicular to the path. `align:'path'`
follows the segment tangent; `align:'fixed'` retains a fixed orientation. `angle`
adds counterclockwise degrees, defaulting to zero.

Pressure interpolates by traveled distance between path vertices. It scales
both radii and coverage; zero pressure emits no deposit. The path includes its
endpoints. The compiler sums lengths with compensation and merges an almost
coincident final spacing interval within 16 machine epsilons of total path
length, so a harmless collinear subdivision cannot add a full extra endpoint
dab. The final dab uses the exact endpoint and its authored pressure. Coincident
vertices have no geometric length; the last endpoint pressure still takes effect.

This is a deterministic polyline/dab system. It does not model time-dependent
wet diffusion, smudging, bristle dynamics, or directly interpret cubic path
commands. Curved paths can be supplied as sampled points, as in the gallery
example. Independent zones let one program restrict sweeps to a creature's
belly, shell, face or other authored region.

## Deposition equations

At one quadrature sample, a dab has brush coverage `b`, optional zone coverage
`z`, authored opacity `o`, and pressure `p`. Its effective coverage is

\[
 a = b z o p.
\]

For dabs `p=1`; the pressure also determined the stroke footprint's dimensions.
With target pigment `c`, accumulated associated pigment `P` and coverage `A`,
the ordered source-over step is

\[
P' = ac + (1-a)P,\qquad A' = a + (1-a)A.
\]

Each supplied finish target `f` has its own associated quantity `F` and coverage
`B`, updated by the same equations. An omitted target leaves that finish pair
unchanged. For example, a later color wash that omits metalness does not erase
an earlier metallic decision. The supported targets are roughness, metalness,
clearcoat and material opacity. A mark's `opacity` controls deposition strength;
`channels.opacity` is a material opacity target.

Height accumulates independently:

\[
H' = H + a h.
\]

Negative `h` describes a cut. Baking averages these completed sample results,
including their ordered overlaps, before writing texels. Applying the result
uses the associated `surface.deposit` operation:

\[
c_{out}=P+(1-A)c_{in},\qquad f_{out}=F+(1-B)f_{in}.
\]

The material boundary clamps the associated quantities to their coverage bounds.
Height lowers directly to `surface.bump(input,H)`, so its analytic derivative
includes the already-baked coverage boundary. It is not multiplied by `A` a
second time. The bake does not replace the input surface's existing slope.

Filtering associated pigment and coverage before deposition avoids the dark
fringes from separately filtering a straight color and then multiplying by a
filtered mask. Fixed SDR reflectance targets make the equations closed under
the positive normalized reconstruction weights used by the image system.

## Compilation, sampling and bounds

`compileMarkProgram(program)` returns a frozen object with `program`, `dabCount`
and `bake(options)`. Reuse it for several resolutions or canvas bounds:

```ts
import {compileMarkProgram} from '@moonweave/surfaces/core';

const prepared = compileMarkProgram(program);
const small = prepared.bake({width: 32, height: 32, samples: 2});
const detailed = prepared.bake({width: 128, height: 128, samples: 4});
```

`bakeMarks` is the convenience path through the same compiler. Each bake prepares
fixed filter footprints once per brush placement and builds 16×16-pixel spatial
bins. Candidate dabs retain authored order in every bin. Pixels visit only their
bin's candidates. Bounds include bilinear support, selected mip levels, virtual
coarse levels and anisotropic taps, including tiny or strongly stretched marks.
For a zoned dab, the binning rectangle is the intersection of the brush and zone
rectangles: `support(brush × zone)` is contained in both filtered supports.
This lets a small zone restrict a broad brush before any per-pixel sampling.
Disjoint supports create no candidate entries. Dense overlapping marks can still
require every dab at a sample; spatial indexing does not change that lower bound.

Zone coverage is evaluated once per touched zone at each quadrature sample.
Two bake-local arrays store values and generation numbers. Advancing the sample
invalidates previous values in constant time; it does not clear every active
zone. The image/component and quadrature limits bound a bake below 2³² samples,
so its unsigned generation numbers cannot wrap. No sample state survives a bake.
`stats.dabTests`, `stats.tileReferences` and `stats.zoneSamples` expose the actual
candidate work and filtered-zone evaluations.

Only zones referenced by emitted dabs acquire a compiled placement or sample
scratch slot. Alternate authored zones remain in the portable program. Finish
and height metadata also comes from emitted dabs: fully transparent marks and
zero-pressure paths do not retain empty finish readers, images or bump nodes in
the resulting surface graph.

`samples` is an integer from 1 to 8, along each texel axis; the default 2 uses
four stratified samples. Brush and zone filters use each subpixel's footprint.
All pigment/finish/height decisions at that sample are composed together before
averaging. This remains bounded numerical quadrature with the existing bounded
anisotropic reconstruction, not an exact pixel integral or EWA filter. Increasing
`samples` resolves more correlated overlaps at higher authoring cost.

The bake integrates correlations among its authored marks. Applying it to a
spatially varying base still samples that base through the ordinary graph; it
does not integrate new cross-correlations between the base's fine detail and the
baked coverage. Decisions whose product must be integrated together belong in
the same bake or another explicitly joint reconstruction.

Canvas bounds are explicit and default to `[0,0,1,1]`. Marks outside the canvas
are cropped. Include padding when the full brush support should remain in the
bake. Applying it uses zero-extended images; the final reconstruction retains
the image system's finite texel-edge support. `applyMarkBake(base,bake,{domain})`
binds the program plane to an existing domain, and `{filter}` selects the final
atlas filter, defaulting to `anisotropic`. This is ordinary graph domain
composition; the mark compiler is not needed in the runtime renderer.

### Resource layout and budgets

| Resource | Channels | Content |
| --- | --- | --- |
| `pigment` | 3 | Associated linear RGB |
| `coverage` | 1 | Pigment coverage |
| `finishValues` | 3 | Associated roughness, metalness, clearcoat |
| `finishCoverage` | 3 | Independent coverage for those three channels |
| `opacityHeight` | 3 | Associated material opacity, opacity coverage, covered height |

The bake uses 13 components per texel. A 128² bake uses 212,992 components and
fits the graph's 262,144-component budget. The Three adapter allows six custom
image resources; a complete mark application uses five. Unused finish or height
readers are not added to the graph. Additional custom images must still fit the
same total graph and adapter limits.

`MARK_LIMITS` bounds a program to 16,384 marks, 65,536 path points, 65,536 attempted
expanded dabs, 256 unique source mask objects, 262,144 source image components and
16 MiB of JSON. The compiler accounts for attempted stroke samples as well as
emitted dabs, so long zero-pressure spans cannot evade the work bound. Entirely
zero-opacity marks and zero-pressure strokes are discarded before expansion.

`serializeMarkProgram` and `parseMarkProgram` roundtrip version-1 authoring data.
JSON contains one indexed `images` table. Each brush or zone stores an integer
`image` reference, so a shared mask is stored once and regains its shared identity
after parsing. The table rejects dangling or unreferenced entries. The remaining
data contains paths and mark styles, not expanded dabs, spatial bins, mip pyramids
or renderer objects. Final material graph serialization uses the ordinary graph
format and its image-resource nodes.

## Evidence and references

`tests/marks.test.mjs` covers ordered color/finish/height deposition, raw ownership,
JSON roundtrips, zones, affine filtering, subpixel bounds, collinear subdivision,
exact fixed-footprint sampler parity, spatial work reduction and graph lowering.
The public type fixture is `tests/marks-color.types.mts`.

Reproduce the gallery-program receipt with:

```sh
node tools/benchmark-marks.mjs
node --expose-gc tools/benchmark-mark-zones.mjs /path/to/baseline
```

The receipt records the actual program, generated graph, image budget, source
hashes, timing samples, determinism checks and candidate work. Its unindexed
sample×dab count is a count comparison, not a measured speedup claim. Runtime
timings depend on the host and do not establish a universal performance result.
`tests/mark-zones.test.mjs` independently checks support intersection against
equivalent localized brushes, all filtered zone modes against uncropped sample
evaluation, per-sample zone reuse, and completely disjoint supports.

The constant-time sample reset uses the generation-marker technique illustrated
by [SuiteSparse:GraphBLAS's sparse accumulator](https://sources.debian.org/src/suitesparse-graphblas/7.4.0%2Bdfsg-1/Source/GB_AxB_saxpy3.c).
This small implementation was written for Moonweave; no GraphBLAS source was copied.

[MyPaint's brush settings](https://github.com/mypaint/libmypaint/blob/master/brushsettings.json)
and [brush-engine documentation](https://www.mypaint.app/en/docs/backend/brush-engine/)
informed the separation of distance-spaced dabs, pressure, orientation and mask
resources. No MyPaint C/C++ source was copied. Numerical filtering remains the
existing Moonweave implementation documented in [FILTERING.md](FILTERING.md).

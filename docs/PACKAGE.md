# Moonweave surfaces

Compose fields and surfaces as immutable typed expressions. Store a pattern independently, share it between pigment, finish and height, and patch the parameters a creature exposes while retaining the compiled structure. The core has no Three, Solid, Effect or browser dependency.

## Install the downloaded package

Install the `.tgz` from the Moonweave download, replacing the example path with your file:

```sh
npm install /path/to/moonweave-surfaces-VERSION.tgz
```

The archive is an ESM npm package with four public paths:

| Import | Purpose |
| --- | --- |
| `@moonweave/surfaces/core` | Expressions, graph documents, compilation, evaluation and deterministic paint data |
| `@moonweave/surfaces/three` | The adapter that receives your Three engine and owns material resources |
| `@moonweave/surfaces/optimize` | Optional typed effect interchange, proof checking and cost gate |
| `@moonweave/surfaces` | Both APIs, backed by the same shared modules |

## Compose and edit

```js
import {facets, surface, scalar, named, materialGraph, patchGraph} from '@moonweave/surfaces/core';

const field = named('bodyField', facets());
const skin = surface.paint(field, 'carapace');
const ivory = surface.paint(field, 'horn');
const strength = named('strength', scalar.parameter(.7));

const graph = materialGraph(surface.mix(skin, ivory, strength));
const next = patchGraph(graph, {
  strength: {value: .4},
  bodyField: {scale: .22},
});
```

Names are graph IDs. Reusing an expression shares its node. A parameter stays editable at every value; a constant can be specialized by the compiler. Unchanged nodes retain identity, and equivalent value patches return the original graph.

## Related pigments and coverage

```js
import {color, mask, scalar, surface, named, materialGraph}
  from '@moonweave/surfaces/core';

const pigment = named('pigment', color.oklch([.62, .08, 220]));
const shadow = color.adjust(pigment, {lightness: -.18, chroma: .65, hue: 12});
const light = color.adjust(pigment, {lightness: .22, chroma: .35, hue: -18});
const accent = color.adjust(pigment, {
  hue: named('accentHue', scalar.parameter(155)),
});
const coverage = mask.chisel({feather: [.15, .55, .2]});
const graph = materialGraph(surface.paint('carapace', {palette: {
  base: color.mix(pigment, accent, coverage, {space: 'oklab'}), shadow, light,
}}));
```

Adjust the shared pigment and its relatives follow. A Domain places each mark;
`mask.chisel` is a finite 3D coverage stamp in local `[-1,1]³`. Feather is measured
in local units. No noise, new atlas or new mask opcode is required. This example
changes pigment while retaining the original painted relief and finish.

Lightness is an offset, chroma a multiplier, and hue uses degrees. Each accepts a
Scalar field. `color.oklab` / `color.oklch` lower once to linear RGB; `color.adjust`
is the runtime operation. Color values retain extended coordinates until the
material's reflectance projection. Perceptual interpolation is not physical
paint mixing, and smooth mask edges are point sampled rather than automatically
filtered. See the complete contracts in [GRAMMAR.md](docs/GRAMMAR.md).

## A texture field can drive color and finish

```js
import {color, scalar, surface, named, materialGraph} from '@moonweave/surfaces/core';
const noise = named('variation', scalar.noise({seed: 42}));
const pigment = color.mix(color.srgb('#243d38'), color.srgb('#b9c28b'),
  scalar.ramp(noise, .25, .75));
const procedural = materialGraph(surface.channels(surface.material(pigment), {
  roughness: scalar.add(.35, scalar.multiply(.5, noise)),
}));
```

This material needs one procedural sample and no facet atlas. Noise is smooth
seeded value noise with a 65,536-cell period; it is point-sampled, without implicit
antialiasing. `color.linear` accepts extended linear RGB coordinates; `color.srgb` decodes
six-digit sRGB colors before mixing. `evaluateColor` samples a named color node
and its differentials without a browser. A reusable pattern is an ordinary
function returning an expression. [The grammar](docs/GRAMMAR.md) describes the
complete operations, types, equations and examples.

Use `color.ramp(field, [[0, dark], [.5, middle], [1, light]], {space: 'oklab', interpolation: 'smoothstep'})` for a typed multi-stop color field. Positions remain editable uniforms; color stops can themselves be varying fields. Connect it to the original painted surface with `surface.paint('carapace', {palette: {base: ramp}})`. Unconnected palette roles retain their style colors. Color fields preserve extended coordinates; generic materials and explicit pigment inputs clamp to reflectance. This projection is not perceptual gamut mapping.

## Sample and reuse a standalone field

```js
import {named, scalar, surface, materialGraph, expressionGraph, graphExpression,
  instantiate, createFieldSampler, parseExpressionGraph, serializeGraph}
  from '@moonweave/surfaces/core';

const fieldGraph = expressionGraph(named('grain', scalar.noise({seed: 17})));
const sample = createFieldSampler(fieldGraph);
const point = sample({position: [.2, .3, .4], dx: [.01, 0, 0], dy: [0, .01, 0]});
const restored = parseExpressionGraph(serializeGraph(fieldGraph));
const imported = graphExpression(restored);
if (imported.kind !== 'noise') throw new TypeError('Expected the saved noise field.');
const reused = instantiate(imported, {prefix: 'shell'});
const shell = materialGraph(surface.bump(surface.paint('carapace'),
  scalar.multiply(.025, reused)));
```

Scalar, color and domain roots can be sampled without a material wrapper.
Every sample gets a fresh context and memo for shared work. A sampler retains
its immutable revision; prepare another after patching. Generic graph documents
also support facet and surface roots, while the CPU field sampler explicitly
rejects those unsupported interpretations. `materialGraph` and `parseGraph`
remain the strict Surface boundaries used by the renderer.

`graphExpression` returns an owned expression with reachable sharing and names
intact. Unused graph definitions are omitted from that expression; the original
graph retains them. An immutable graph/root reuses its expression, while a
patched revision has a separate one.

`surface.bump(input, scalarHeight)` adds analytic height detail to a surface.
Amplitude and masks are ordinary scalar arithmetic. The product rule preserves
the derivative of a varying height mask. Color and finish are inherited, and the
operation adds no atlas reads. It changes shading without moving geometry.

To reuse a named template, use `instantiate(expression, {prefix, shared})`. Shared roots must be constructor-owned expressions. Construct or name a raw shared value once before inserting it into the template; raw local templates are snapshotted.
Local nodes, including unnamed editable values, are copied; authored `depth`
becomes `left_depth` under prefix `left`. Explicitly shared subgraphs retain
identity. Coordinate placement stays in `inDomain`; ordinary functions remain
the reusable pattern abstraction.

## Render with Three

Core consumers need no engine dependency. Adapter consumers supply Three; TypeScript consumers also supply its matching `@types/three` declarations. The atelier's verified current engine is Three `0.187.0`:

```sh
npm install three@0.187.0
npm install --save-dev @types/three@0.187.0
```

```js
import * as THREE from 'three';
import {createTexturingSystem, bindSurfaceCoordinates} from '@moonweave/surfaces/three';

const system = createTexturingSystem(THREE);
const handle = system.createMaterial(graph, {coordinates: 'attribute'});
bindSurfaceCoordinates(THREE, mesh.geometry);
mesh.material = handle.material;

handle.patch({strength: {value: .4}});
// When the scene no longer uses the system:
system.dispose();
```

The adapter targets Three's WebGL renderer with a WebGL2 context. Noise uses GLSL ES3 integer arithmetic, including on an r140 host. Mesh creation, camera, lighting and rendering belong to the host. Narrow engine capability records are supported when an application wants its bundler to remove unused Three exports; they must include `FloatType`, `NearestFilter` and `ClampToEdgeWrapping` for image resources, as declared by `TexturingEngine`.

## Package contents

Keep the entry modules and their `chunks/` directory together when copying the portable ZIP directly. npm resolves these relationships automatically. `types/` contains standalone declarations, including the generated algebra signature; consumers do not compile Moonweave's source TypeScript.

The runtime package contains selected integration documentation and example graph JSON. The separate source ZIP contains the atelier, complete source, tests, build tools and research records. The downloadable package is marked private; it is installable from this tarball and has not been published to the npm registry.

- [Typed grammar and reusable patterns](docs/GRAMMAR.md)
- [Integration and mathematical contracts](docs/TEXTURING.md)
- [Module ownership and composition rules](docs/ARCHITECTURE.md)
- [Build and package verification](docs/PACKAGING.md)
- [Image footprints and filtering](docs/FILTERING.md)

## Procedural application system

For LLM-authored resources, named coverage zones and composable spectral quantities, start with [APPLICATIONS.md](docs/APPLICATIONS.md). The package includes `examples/zones.json` (Cobalt & gilt), `examples/pigments.json` (Spectral patina), and `examples/inscription.json` (Inscribed glaze). Each embeds generated texels; no manual brush images or asynchronous asset loader is required.

Images have their own graph sort. Construct them through `image.data` or `image.generate`, then sample with `scalar.image` or `color.image`. `zone`/`applyZones` lower pigment, partial finish and height into normal graph operations. `pigment.add`/`scale` preserve weighted spectral quantities until `pigment.color` or `pigment.toLinear` projects them. The spectral adaptation and basis tables retain the included `SPECTRAL-LICENSE.txt` MIT notice.

Readers accept `{address: 'zero', filter: 'anisotropic'}` for finite marks,
`trilinear` for mip filtering, or the default `linear` for legacy point
reconstruction. `clamp` and `repeat` remain available. The CPU sampler accepts an
independent `footprint: {dx,dy}`; the Three adapter derives it from screen
tangents. RGB and scalar projections of one image in one frame share the
filtered sample. Mipmaps are derived data and do not enlarge graph JSON.

Inscribed glaze reuses a packed coverage/deposition/finish image in two frames.
It bakes correlated coverage and height before filtering, because filtering a
product differs from multiplying filtered fields. [FILTERING.md](docs/FILTERING.md)
contains a complete example, the calculus, storage/work accounting and limits.

Custom `foldGraph` interpretations implement every operation reached by their inputs. Resource-backed graphs need an Image interpretation and the appropriate `imageScalar` or `imageColor` handlers; applied mark bakes also use `deposit` and may use `bump`. The typed signature makes these requirements explicit. Saved version-1 graphs migrate at import to the canonical version-2 representation.

## Optional offline optimization

`@moonweave/surfaces/optimize` exports `createOptimizationJob`,
`verifyOptimization` and `applyOptimization`. It uses typed source atoms, exact
surface-product observations and the production compiler's DAG cost accounting.
The default renderer path does not load optimization code. The complete source
archive includes the pinned egglog runner and graph simulation tools. See
[OPTIMIZATION.md](docs/OPTIMIZATION.md) for setup, equations and measured results.

## Inspect shared execution

`inspectGraph(graph)` returns the compiled nodes and typed input edges using dense
integer endpoints, plus authored aliases and source IDs without a live
representative. It shares its immutable projection across value edits. The
atelier displays this same data under Inspect graph. See
[SHARING.md](docs/SHARING.md) for the representation, CPU sharing boundary,
TypeScript coverage and measured preparation/sampling tradeoff.


## Canonical palettes, managed color and marks

Recipes use `{version:2, mapping, style, palette}`. Every palette role is a Color
expression; numeric styles contain no swatches. Saved v1 graphs migrate at import,
and flat recipes use `migrateSurfaceRecipe`. New input uses the canonical form.

All public declarations are generated from strict owning implementations. Read
[COLOR.md](docs/COLOR.md) for tagged color and output gamut mapping, and
[MARKS.md](docs/MARKS.md) for pressure strokes, independent finish coverage,
indexed baking and reusable graph applications. `examples/marks.program.json`
is the portable authored mark program; `examples/marks.json` is its baked graph.

# Moonweave — composable procedural surfaces

Moonweave is a renderer-independent expression system for LLM-authored creature textures. Generate numeric images and pigment palettes, name the regions that differentiate a surface, apply color, finish and height, then serialize the complete graph. The existing painted-facet appearance remains one reusable source in that language.

**Version 0.62.0.** The installable archive is prepared for npm consumption; it has not been published to the npm registry. The source tree, examples, licenses and verification evidence travel with the source release.

[Documentation](docs/README.md) · [Source map](AGENTS.md) ·
[Contributing](CONTRIBUTING.md) · [Release verification](docs/VERIFICATION.md)

Every public API is declared by its checked implementation; package declarations
are generated. Graph v2 has one palette representation: three required Color
inputs, in extended linear Rec.709. Numeric paint styles contain no swatches.
Saved v1 graphs migrate once at import; new recipes use `{mapping, style, palette}`.

Zones snapshot their whole record with one ownership operation. CPU outputs share
one graph-owned preparation and can be sampled together with one context and memo.
A portable mark program adds ordered dabs, pressure strokes, transformed masks and
zones. Its bake preserves associated pigment, independent finish coverage and
covered height before filtering, then lowers to the ordinary surface graph.

Validated graph nodes and mark programs retain identity when reused. Recovering
several expressions visits their shared definitions once. Inactive marks and
unused zones contribute no derived finish or placement work. The atelier saves
one reset baseline plus changed-node references, and exposes extended linear
RGB controls directly beside each literal palette connection.

Read [COLOR.md](docs/COLOR.md) for tagged-color conversion and explicit perceptual
gamut mapping, [MARKS.md](docs/MARKS.md) for executable mark programs, and
[ARCHITECTURE.md](docs/ARCHITECTURE.md) for ownership and module boundaries.

## Start with the application API

```js
import {
  image, pigment, color, scalar, surface, zone, applyZones,
  named, materialGraph, serializeGraph,
} from '@moonweave/surfaces/core';

const ochre = pigment.srgb('#dcc878');
const blue = pigment.srgb('#315e79');
const palette = named('palette', image.generate(
  {width: 64, height: 1, channels: 3},
  (_u, _v, x) => pigment.toLinear(pigment.mix(ochre, blue, x / 63)),
));
const region = named('region', scalar.ramp(scalar.axis('y'), -.5, .6));
const amount = named('amount', scalar.parameter(.8));
const graph = materialGraph(applyZones(surface.paint('carapace'), [
  zone('pigmentWash', scalar.multiply(region, amount), {
    color: color.image(palette, {filter: 'trilinear'}),
    channels: {roughness: .74, metalness: .03},
    height: .003,
  }),
]));

const text = serializeGraph(graph);
```

`image.generate` runs its callback once at authoring time. The stored graph contains pixels and references, with no callback, URL, manual painting step or asynchronous loader. An image reader uses its domain's `position.xy` as UV; affine domains place, rotate and scale it. Scalar and RGB readers can share the same resource.

The application tutorial covers placement, coverage, spectral algebra and complete examples: [APPLICATIONS.md](docs/APPLICATIONS.md). Start source navigation with [AGENTS.md](AGENTS.md).

## Install and render

```sh
npm install ./moonweave-surfaces-0.62.0.tgz
```

```js
import * as THREE from 'three';
import {createTexturingSystem, bindSurfaceCoordinates}
  from '@moonweave/surfaces/three';

const system = createTexturingSystem(THREE);
bindSurfaceCoordinates(THREE, mesh.geometry);
const handle = system.createMaterial(graph, {coordinates: 'attribute'});
mesh.material = handle.material;
handle.patch({amount: {value: .5}});
// At the end of this owner's lifetime:
system.dispose();
```

The host supplies Three, geometry, lights and the renderer. Supported engine versions are declared in `package.json`; TypeScript hosts also install matching Three declarations. The pure core has no Three, Solid, Effect or DOM dependency. All package entries share one implementation and graph identity.

| Import | Purpose |
| --- | --- |
| `@moonweave/surfaces/core` | Expressions, image data, pigment quantities, zones, validation, compilation and CPU fields |
| `@moonweave/surfaces/three` | Injected Three adapter, coordinates, material and texture ownership |
| `@moonweave/surfaces/optimize` | Typed effect terms, exact component verification and compiled-DAG cost acceptance |
| `@moonweave/surfaces` | Both APIs |

## Optimize a composed application

The optional optimizer runs real egglog offline. It exposes 24 exact surface-effect equations, retains source identities and verifies all six material components before accepting a cheaper compiled DAG. This can remove a finish field hidden behind coats and slope operations when a later application overrides that finish. The graph grammar, default compiler and runtime rendering path stay the same.

Before equality exploration, a finite demand projection follows the finish
components needed by each consumer, including through nested mixes. Four finish
bits bound this phase to 16 contexts per source surface. Shared consumers remain
distinct when they need different components; partial observations never become
full-surface equalities. The independent checker and compiled cost gate still
decide whether an extracted candidate is usable.

```sh
python3 -m venv .venv-egglog  # Python 3.12+
.venv-egglog/bin/python -m pip install -r tools/egglog/requirements.txt
node tools/optimize-graph.mjs authored.json optimized.json \
  --python .venv-egglog/bin/python --artifacts validation/optimization
```

The full source includes the runner and finite graph simulation tools. The runtime package includes the dependency-free `/optimize` interchange and verifier. See [OPTIMIZATION.md](docs/OPTIMIZATION.md) for the equations, API, cost policy, reproducible measurements and limits.

For a complete authored example, run
`MOONWEAVE_EGGLOG_PYTHON=.venv-egglog/bin/python node examples/optimize-effects.mjs`.
It writes ordinary authored/optimized graph documents and a checked receipt.

## Work follows its owner

Immutable images own lazy per-channel range summaries, so adding readers or
changing their mappings does not repeatedly scan the same pixels. Mark bins
intersect conservative filtered brush and zone supports before rasterization;
bake-local generation markers reuse touched zone samples without clearing every
zone for every sample. These changes preserve authored order and sampling policy.
The release report includes scaling measurements, raw-input controls and
small-case overhead, with their exact workload limits.

## Composition contracts

| Layer | Representation and law |
| --- | --- |
| Coverage | Scalar fields in `[0,1]`; intersection `ab`, union `a+(1-a)b`, subtraction `a(1-b)` |
| Applications | Ordered zone arrays; concatenation means successive application; an empty array is identity |
| Associated deposition | `p + (1-a)c`, with independent associated finish contributions and preserved slope |
| Pigment coating | Changes only surface color; retains finish, opacity and existing slope |
| Finish | Partial channel overrides, blended by coverage; unspecified channels survive |
| Height | Adds `D(mh) = m Dh + h Dm`, including the boundary term |
| Spectral quantities | Additive concentration and 38 weighted K/S moments; projection happens after composition |
| Image fields | Shared float32 data; clamp/repeat/zero extension; linear, trilinear or bounded anisotropic reconstruction |
| Pixel footprint | Separate from differentiation directions; transported through affine domains; fixed while differentiating filtered values |
| Graph edits | Parameters and resource data update bindings; kinds, references and sampling modes change structure |

These are distinct algebras. Soft coverage is not Boolean set union; partial coverage is not idempotent. Spectral `mix` uses squared blend factors and is not associative. Floating-point sums and transforms retain their authored order even when a real-number identity exists.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/core/` | Signature, immutable graph, compiler, image/field calculus and optional optimizer |
| `src/color/` | Tagged color management, spectral quantities and attributed coefficient data |
| `src/paint/` | Portable marks, spatial baking, graph application and deterministic facet atlas |
| `src/three/` | Injected engine adapter, shaders, coordinates and texture lifetime |
| `lab/` | Executable examples, Solid editor and Effect-owned graphics/browser sessions |
| `examples/` | Runnable source workflows, including the complete egglog optimization path |
| `tests/` | Behavioral/type contracts and isolated installed-package consumers |
| `tools/` | [Build, optimization, measurement and verification commands](tools/README.md) |
| `docs/` | Current guides and evidence; prior release records under `docs/history/` |
| `.github/workflows/` | Source/package checks ready for a GitHub repository; no publication job |

[AGENTS.md](AGENTS.md) maps individual owners and the rules for extending them.
The source ZIP preserves this layout, the lockfile and contributor instructions.
It excludes Site configuration, Git metadata, local environments and generated
output; it can become a standalone repository without a hosting account.

## Build and verify

Node 24 or later is required for source development.

```sh
npm ci
npm test
npm run typecheck
npm run test:types
python3 tools/test_package.py
npm run build
npm run check:package
python3 tools/check-source.py validation/source-package.json
```

Optional native validation runs with
`python3 tools/validate-texturing-gpu.py validation/native-local`. It requires
Mesa EGL/GLES3 and uses the actual Three r140/r187 physical shader assemblies.
It is separate from browser verification. The atelier reports WebGL2
initialization and shader failures explicitly; its source editor remains usable
when no graphics context is available. See [CONTRIBUTING.md](CONTRIBUTING.md) for
the local preview and egglog setup commands.

The build creates the Site, reusable ESM entries, an npm TGZ, a ZIP of the identical runtime payload and a complete source ZIP. See [PACKAGING.md](docs/PACKAGING.md) for reproduction and [VERIFICATION.md](docs/VERIFICATION.md) for the current results and limitations.

## Scope and next boundary

The six sorts are Image, Domain, Scalar, Color, Facets and Surface. Images are numeric resources: color sampling interprets RGB as linear Rec.709, while scalar sampling selects a channel. Filtered readers use deterministic mipmaps and explicit pixel footprints; anisotropic reconstruction has a bounded eight-tap major-axis approximation. Zero extension keeps finite marks local and dilutes them below a pixel through virtual coarse levels. The exact contract, costs and approximation limits are in [FILTERING.md](docs/FILTERING.md). Height changes shading slopes rather than mesh geometry. Surface blending is parameter composition, not a physical stack of optical layers.

The graph permits 256 nodes, depth 64 and 262,144 total authored image components; imports allow 16 MiB of JSON so supported embedded images can round-trip. Derived mip levels are cached outside graph data. The current Three adapter permits six image resources alongside its optional atlas pair. Image textures require float texture support; explicit reconstruction uses nearest float reads and does not require float-linear filtering.

## Detailed references

- [APPLICATIONS.md](docs/APPLICATIONS.md): executable procedural application walkthrough.
- [GRAMMAR.md](docs/GRAMMAR.md): exact types, semantics, differentials and identities.
- [OPTIMIZATION.md](docs/OPTIMIZATION.md): exact effects, egglog, checked extraction and graph simulations.
- [FILTERING.md](docs/FILTERING.md): image footprints, finite masks, mipmaps and anisotropic sampling.
- [TEXTURING.md](docs/TEXTURING.md): API and renderer integration contracts.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): representation and ownership decisions.
- [RESEARCH.md](docs/RESEARCH.md): researched representations, alternatives and source comparisons.
- [COLOR-STUDY.md](docs/COLOR-STUDY.md): production references and primary-source comparisons.
- [GRAPHICS.md](docs/GRAPHICS.md): systematic graphics failure diagnosis.

The source and runtime archives retain the Spectral.js, W3C color and Three
notices. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) identifies their owners
and adapted material. Moonweave's own package remains marked `UNLICENSED` and
private; upstream licenses do not relicense the project.

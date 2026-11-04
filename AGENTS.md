# Moonweave source map

Moonweave is an LLM-authored procedural texturing library with a Solid/Effect
atelier. The saved graph is the portable program. Authoring helpers lower to the
same typed graph consumed by CPU interpreters and the Three adapter.

## Entry points and files

| Location | Responsibility |
| --- | --- |
| `src/core.mjs`, `src/core/public-types.mts` | Renderer-free value/type reexports from owning implementations |
| `src/core/algebra.mts` | Operation signature, sorts, typed ports, validation and generic traversal |
| `src/core/graph.mts` | Owned expressions, graph documents, naming, instancing, domain binding and patches |
| `src/core/intern.mts` | One signature-derived structural key for compiler, CPU preparation and optimizer |
| `src/core/inspect.mts` | Cached projection of live nodes, typed edges and source aliases |
| `src/core/compile.mts` | Literal specialization, sharing, live-node plans, value binding and cost accounting |
| `src/core/analyze.mts` | Domain validation and scalar/opacity ranges; caller-owned fixed-slot memo |
| `src/core/effects.mts` | Closed typed effect equations and independent symbolic component interpretation |
| `src/core/optimize.mts`, `src/optimize.mjs` | Optional export, candidate validation, source-preserving reification and compiled DAG cost gate |
| `src/core/field-evaluate.mts`, `evaluate.mts` | Prepared CPU field interpreters and analytic first differentials |
| `src/core/resources.mts` | Float32 image ownership, generation and bilinear reconstruction |
| `src/core/image-filter.mts` | Derived mip pyramids, footprint planning, trilinear and bounded anisotropic filtering |
| `src/core/coverage.mts`, `masks.mts`, `zones.mts` | Coverage algebra, finite masks and ordered applications |
| `src/core/color.mts`, `color-sample.mts` | Color conversions and color differential calculations |
| `src/color/pigment.mts`, `spectral-data.mjs` | Authoring-time additive spectral quantities and upstream basis data |
| `src/paint/` | Deterministic facet data, portable marks, spatially indexed baking and surface lowering |
| `src/color/management.mts` | Tagged SDR D65 color conversion and explicit display gamut mapping |
| `src/core/ownership.mts`, `migrate.mts` | Shared snapshot proof; explicit v1 document migration |
| `src/three/fields.mjs`, `shader.mjs` | Field GLSL and final surface shader composition |
| `src/three/images.mts`, `textures.mts` | Custom float images and original facet-atlas textures |
| `src/three/uniforms.mts`, `adapter.mts` | Live bindings, material ownership and resource lifetime |
| `src/three/coordinates.mts` | Rest-coordinate attributes for host geometry |
| `lab/application-examples.mts` | Fully generated zone/image/spectral studies |
| `lab/composition.mts` | Composition inspection and pure editor commands |
| `lab/examples.mts` | Labeled graph factories shared by the gallery, examples and validation tools |
| `lab/components/`, `editor.ts`, `history.mts` | Solid UI, persistent graph editing and undo |
| `lab/graphics-session.ts`, `stage.ts` | Browser graphics lifecycle and scene integration |
| `tests/consumer/` | Installed-package runtime and type fixtures |
| `tools/build.mjs`, `package.py`, `check-package.mjs` | Reproducible site/package build and isolated consumer checks |
| `tools/egglog/`, `optimize-graph.mjs` | Pinned offline equality saturation and bounded subprocess execution |
| `tools/compare-graphs.mjs`, `measure-optimization.mjs` | Finite graph observations, editable revisions and optimization evidence |

`src/index.mjs` combines `/core` and `/three`. The separate `/optimize` entry
exports pure optimization interchange and verification. `/core` and `/optimize`
have no Three, Solid, Effect or browser dependency. `/three` receives the host's Three capabilities.
Internal source paths are not package exports. `dist/` and `build/package/` are
generated output; authored changes belong in `src/`, `lab/`, `tools/` or `docs/`.

The graph ownership, compiler, inspection, CPU preparation, color math and optional
optimizer implementations are strict TypeScript (`.mts`). The atelier is Solid TSX;
public resource, pigment, mark and Three adapter owners are checked `.mts` modules.
Private GLSL templates and geometric/random paint kernels remain ES modules.
Public declarations are emitted from owners; never add parallel handwritten signatures.

## Representation contracts

- Graph v2 has 26 operations. Paint requires all three Color references; numeric
  styles have no palette. Old graph/recipe swatches exist only in explicit import
  migration. The signature has six sorts: Domain, Scalar, Color, Image, Facets and Surface.
  Image is numeric data; scalar/color readers apply a domain's XY coordinates.
- Constructors snapshot raw author data and borrow already-owned expressions.
  Copied expression descendants become owned after the snapshot is frozen, so
  extracting and reusing a child preserves the identity already in its parent.
  Reuse owned objects for DAG sharing. `named` assigns node IDs;
  `instantiate` prefixes local IDs and borrows explicitly shared inputs.
- Normalized nodes and mark programs carry proofs from their own validation
  boundary. `normalizeNode` and `patchNodeValues` publish the same node proof;
  `markProgram` borrows only programs it validated. Frozen caller data still
  crosses validation. New graphs always check all references and total budgets.
- Constants are structural literals. Parameters and declared node values are
  editable. A current parameter value of zero must not remove its live branch.
- Floating-point grouping is authored structure. Real-algebra identities do not
  permit arbitrary reassociation or cancellation of nested complements.
- Coverage helpers assume `[0,1]` inputs. Union is `a+(1-a)b`, intersection is
  `ab`, subtraction is `a(1-b)`. These are graded, non-idempotent operations.
- Zone labels describe applications; only `named()` assigns graph IDs. A zone
  snapshots `{mask,effects}` once, preserving raw root/descendant sharing.
- Zones fold in order. Pigment and finish move toward targets; height adds
  `D(coverage*height)`, including the coverage-boundary term. Coat preserves
  earlier finish and slope; relief scales slope; bump adds a height differential.
- Mark programs retain ordered strokes/dabs, source brushes and finite zones.
  Bake correlated pigment/coverage, independent finish contributions and covered
  height together; `surface.deposit` applies associated contributions without
  unpremultiplication. Expanded dabs and tile bins never enter graph JSON.
  Only emitted dabs retain derived finish/height metadata and zone placements;
  unused authored inputs remain validated and serializable.
  Spatial bins intersect the conservative filtered brush/zone supports. Zone
  values use bake-local sample generations, never a full-zone clear per sample.
- Color fields use extended linear Rec.709 values. Oklab operations preserve
  intermediates; material reflectance boundaries clamp. Custom RGB images are
  already linear. Scalar image data has no color encoding.
- Image callbacks run only during generation; graph JSON stores float32 samples.
  Readers declare clamp/repeat/zero extension and linear/trilinear/anisotropic
  filtering. Omitted filtering keeps the v55 linear point contract. Derived
  mipmaps are cached by owned resource identity, outside the serialized graph.
  The same immutable resource owns lazy per-channel range summaries; reader
  mapping/filter changes cannot rescan already-analyzed image pixels.
- Pixel footprints are independent from differentiation directions. Affine
  domains transport both. Filtered partials hold the footprint, LOD and taps
  fixed; filtering individual fields does not integrate their nonlinear products.
  Bake correlated decisions together when their integrated product is intended.
- Finite image masks use zero extension. Virtual coarse levels preserve their
  integrated mass below a pixel; the bounded anisotropic policy is an explicit
  approximation, not EWA or exact pixel integration.
- Pigment quantities retain additive concentration and weighted K/S moments.
  Project to RGB at an output boundary. `pigment.mix` uses squared factors and is
  not associative; `add`/`scale` carry the compositional quantity law.
- The original facet atlas and custom images have distinct sampling policies and
  ownership. Resource lifetime belongs to the adapter, not the pure graph core.
  Disposal clears texture uniform slots and the atlas owner's pair/pending bytes;
  disposed handles may retain graph data but must not retain those texture slots.

Cache ownership is documented in `docs/ARCHITECTURE.md`. Keep each derived value
with its immutable graph, topology, resource or explicit renderer owner. Local
fold maps and per-sample memos are not persistent stores. Do not introduce a
general cache manager or a second mutable graph to coordinate those lifetimes.

## Extending an operation

The optimization ruleset is `surface-effects/1`. Non-surface fields and base
surfaces are opaque source atoms. Extend effect operators, typed equations and
the independent symbolic product interpretation together; preserve operation
grouping inside every component. Python generates its language from the exported
manifest. It does not own a second handwritten rule set. Extracted candidates
must pass all six symbolic observations and strictly improve at least one
compiled cost without worsening another. Never trust an engine cost or receipt
as a correctness certificate. Numerical graph simulation supplies finite
observations; it does not establish a new universal rewrite law.

Finish-demand projection is generated from channel writers and the signature's
explicit `componentwise` promise. It runs over a separate immutable source sort,
so projected results cannot become new analysis inputs. Four finish components
give at most 16 demand contexts per source surface. An interrupted projection
returns the original root; the ordinary equation search starts only after that
phase saturates. Do not infer componentwise behavior for new operations or merge
a partially observed surface with its full source value.

Start in `src/core/algebra.mts`: result sort, reference ports, literal payloads
and editable values belong together. Generic validation, traversal, graph types
and folds derive from this signature. Add its typed constructor in `graph.mts`;
public value/type barrels reexport that owner, and declarations are generated.

Field operations have a CPU interpretation in `field-evaluate.mts` and GPU
lowering in `three/fields.mjs`, including derivative demand when used as height.
Surface operations lower in `three/shader.mjs`. Resource values use
`three/uniforms.mts` and the appropriate adapter-owned texture path. Update
compiler folding, range analysis and cost accounting for the operation's actual
behavior. UI descriptions live in `lab/composition.mts` and relevant components.

Keep calculations independent of UI state. Verify numerical laws, ownership,
serialization and CPU/GPU behavior at the changed boundary. Preserve existing
programs and imagery when an added feature is unused. Include third-party source
notices with derived numerical implementations; the spectral notice is
`src/color/SPECTRAL-LICENSE.txt`.

## Commands and guides

The source runtime is Node 24+. After dependency installation:

```sh
npm test
npm run typecheck
npm run test:types
npm run build
npm run check:package
python3 tools/check-source.py
```

For a compiler/layout change, `node tools/check-gallery.mjs <baseline-checkout>
[receipt.json]` compares every gallery graph, plan, generated shader and bound
uniform against that baseline using the installed Three versions. It assembles
source with a recording GL object; it does not claim compilation or rendering.

Use individual Node test files for a focused edit. Native Mesa EGL/GLES3 checks
run with `python tools/validate-texturing-gpu.py validation/native`; the
`MOONWEAVE_NATIVE_SPECIMEN=shell` environment variable selects the shell specimen.
`tools/audit-bundle.mjs` compares production builds, while the measurement tools
record specific program/field changes. Native rendering and browser capability
checks provide different evidence; report them separately.

Read `docs/APPLICATIONS.md` for executable LLM authoring, `docs/FILTERING.md` for
image sampling and footprint contracts, `docs/GRAMMAR.md` for
equations and sampling conventions, `docs/ARCHITECTURE.md` for module boundaries,
and `docs/PACKAGING.md` for source versus runtime output. The build creates the
staged npm manifest and distribution files; the development manifest is private.
`docs/VERIFICATION.md` records completed release checks.

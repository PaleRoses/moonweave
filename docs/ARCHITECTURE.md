# Moonweave: representation and ownership

The graph, compiler, CPU preparation, resource/filtering boundaries, color
management, mark authoring and public adapters own their TypeScript contracts.
Public declarations are generated from those implementations. The
signature-derived sharing key and actual execution inspection are documented in
[SHARING.md](SHARING.md).

The reusable object is an immutable typed expression. A field can be a complete graph before it belongs to a material. The atelier is one editor for surface graphs, and the Three adapter is one renderer for them. Neither owns the meaning of the expression.

Image resources, scalar/RGB readers, coating and deposited marks form the
authored application boundary. Zones label ordered applications and lower into
the field and surface algebra. Serializable dab/stroke programs bake brush,
coverage, color and finish decisions into image resources for that same graph.
Spectral quantities retain additive concentration and K/S moments until
projection; the GPU samples their baked RGB tables.

Revision 56 adds explicit reader filtering and a CPU pixel footprint independent
of calculus directions. Trilinear and bounded anisotropic reconstructions share
deterministic mip data; finite zero-addressed marks keep diluting after the
terminal mip. The same reconstruction produces value and frozen-footprint
partials. [APPLICATIONS.md](APPLICATIONS.md) is the executable entry point;
[GRAMMAR.md](GRAMMAR.md) and [FILTERING.md](FILTERING.md) define the contracts.

## Source and distribution ownership

| Path | Responsibility |
| --- | --- |
| `src/core/algebra.mts`, `src/core/types.mts` | Operation-derived expression/node types and canonical graph/plan data contracts |
| `src/core/ownership.mts` | One construction proof and sharing-preserving snapshot for expressions, recipes and resources |
| `src/core/evaluate.mts`, `src/core/field-evaluate.mts` | One incremental preparation per immutable graph; typed single/multiple outputs and fresh per-sample state |
| `src/core/compile.mts`, `src/core/analyze.mts` | Structural lowering/value binding, then domain/range analysis; shared topology owns analysis entries |
| `src/core/image-filter.mts`, `src/core/resources.mts` | Immutable images, derived mip pyramids, footprint analysis and CPU filtered reconstruction |
| `src/color/` | Working/display color conversion, spectral authoring, attributed basis tables and upstream licenses |
| `src/paint/` | Deterministic atlas generation and dab/stroke program validation, compilation, baking and graph application |
| `src/three/` | Renderer capabilities, shader interpretation, uniform binding, GPU resources and coordinates |
| `src/core.mjs`, `src/three.mjs`, `src/optimize.mjs`, `src/index.mjs` | The four public module boundaries |
| Owning `.mts` modules and type-only export barrels | Function signatures and public interfaces beside their implementations; no separate handwritten public declaration API |
| `build/package/types/` | Generated public declaration dependency closure, with source `.mts` imports rewritten to distribution `.mjs` specifiers |
| `lab/` | Editor application and its resource owners |
| `tests/consumer/` | Consumers compiled and run against the installed npm tarball |
| `build/package/` | Generated runtime package, with an explicit file allowlist |
| `dist/` | Hosted app, ESM entries, documentation and downloadable releases |

App code uses the public core/adapter boundary unless it needs an explicitly internal operation. There is one implementation and one set of shared ESM chunks across all package entry points. `tsc --declaration` reads the same source modules consumers execute through the generated JavaScript. The type-only barrels collect exports without restating function signatures. Some internal GLSL generators, low-level atlas kernels and the spectral data table remain JavaScript; this is not a claim that every repository file is TypeScript. The complete source release retains tools and evidence; the runtime package ships the modules, generated declarations, usage documentation and examples required by a consumer. See [PACKAGING.md](PACKAGING.md).

## Six sorts with explicit operations

| Sort | Meaning | Operations |
| --- | --- | --- |
| Image | Immutable numeric float32 data, shared by typed readers | Data construction and procedural tabulation |
| Domain | Coordinate frame, with point, normal, differential and pixel-footprint rules | Affine transform, optional preceding domain |
| Scalar | A numeric field and its supported differentials | Constant, parameter, axis, facing, noise, ramp, add, multiply, complement, image channel sampling |
| Color | Extended linear Rec.709 coordinates and supported differentials | Editable RGB, explicit linear/Oklab mixing, multi-stop ramp, perceptual adjustment, image RGB sampling |
| Facets | One lookup of the deterministic painted field in a domain | Scale, stretch, rotation, seed, optional domain |
| Surface | Linear pigment, finish channels and unresolved relief slopes | Color material, paint, masked mix, channel overrides, relief scaling, height application, coating and premultiplied deposition |

`src/core/algebra.mts` defines the language signature. Each operation declares a result sort, typed reference ports, static data and editable data together. Types for expression trees, graph nodes and value patches derive from those definitions. Paint patches retain their nested partial numeric-style contract. Validation, reference traversal, remapping, patch eligibility and structural lowering consume that same information. Adding an operation therefore has one structural definition, followed by the interpreters that give it meaning. Color-ramp inputs use a typed list port. Every canonical paint palette has three color references: `base`, `shadow` and `light`. Authoring defaults are resolved before graph construction, and graph-v1 imports migrate once to these references. There is no runtime legacy-swatch precedence. Ramp positions are values; stop references, count, interpolation and space are structural.

Color fields preserve extended coordinates through intermediate mixtures. Generic material construction clamps to reflectance; explicit paint-palette fields are projected before entering the unchanged pigment kernel. The original kernel may apply its existing artistic grain gain. One D65/Oklab coefficient table generates both CPU conversions and GLSL constants. CPU derivatives pass through each conversion Jacobian and mixture product rule; singular tangents are explicit errors. The optional authoring API now includes an attributed Spectral.js adaptation; its spectral calculations are baked before fragment evaluation.

This is a finite, many-sorted algebra. It is not a promise that all expressions commute or associate. The GPU evaluates floating-point operations in a particular order. Reassociation, matrix pre-multiplication, repeated complement elimination and physically different material operations cannot be justified by real-number algebra alone.

### The law for finish overrides

A channel override is a partial map from `roughness`, `metalness`, `clearcoat` and `opacity` to scalar expressions. Define `A ⊕ B` by taking `B`'s value when it contains the channel, otherwise `A`'s. Empty maps are identities; this merge is associative and generally not commutative. Its action on a surface is:

```text
channels(channels(surface, A), B) = channels(surface, A ⊕ B)
channels(surface, {}) = surface
```

The compiler applies this rule locally to an already-lowered child, in the signature's fixed channel order. Postorder traversal handles a longer chain without an iterative rewrite engine. Ordinary reachability then removes fully shadowed scalar work and its bindings. If another surface still references the inner override, that branch retains it. The immutable authored graph and its names are unchanged. No scalar sum/product, complement or matrix transform is reordered by this rule.

### A mask edit is substitution in a context

For a recognized mask, retain the scalar context around its coordinate: complements, a strength multiplication in its original order, and the ramp. Changing Position to Surface direction substitutes a coordinate in that context. It preserves accepted strength, bounds, domains and all outer operations. A copied path belongs to the selected blend, so a shared mask used elsewhere keeps its original behavior.

In particular, `1 − a × r` and `a × (1 − r)` are distinct. Reversal of the complete mask and reversal inside a region cannot be represented by one undifferentiated boolean. Unknown or ambiguous scalar products remain custom; inspection does not pretend to understand a composition it cannot uniquely decompose.

### Expressions, documents and programs

An expression is convenient to compose in code. A version-2 graph document gives shared nodes stable IDs and can be serialized. Version-1 documents are accepted through a single migration to that canonical form. A compiled plan retains only reachable work, specializes literals, shares eligible samples, computes resource cost and exposes value bindings. Numeric edits preserve the graph's topology and the compiled program structure.

`expressionGraph` validates any root sort through the same boundary. Its topology
retains the inferred result sort without adding serialized metadata.
`materialGraph`, `parseGraph` and the renderer compiler remain strict Surface
boundaries; `parseExpressionGraph` imports generic roots. `createFieldSampler`
prepares a scalar, color or domain root directly to a context function. Its
explicit output-record overload selects several typed roots from the same
graph, including field roots inside a material. No dummy material is needed for
a field program.

`graphExpression(graph, rootId?)` closes the reverse path from stored documents
to composable expressions. It uses the existing DAG fold and typed reference
mapping to reconstruct only the selected root's reachable definitions, with
stored IDs and sharing intact. A weak graph cache owns one expression per node
ID, so an extracted child is the same object used inside another recovered
root. Each immutable graph revision has its own cache. Unused imported nodes
remain validated document data and are omitted by expression reconstruction.
The conversion adds no grammar operation or serialized wrapper.

That existing expression map is also the DAG fold's memo. Requesting another
root visits only definitions that were not already recovered, rather than
walking shared descendants again before finding their existing expressions.

Normalized graph nodes carry a private validation proof. Rebuilding a document
can borrow those exact frozen records, including nodes produced by value
patches. Every new document still checks references, sorts, cycles, depth and
the aggregate image budget; node reuse does not bypass graph validation.

`named(id, expression)` supplies that document ID while preserving the expression's sort. No alias operator, label registry or controller object is introduced. Lowering first visits the bounded expression DAG in postorder and reserves authored IDs, then assigns unused generated IDs and emits nodes. This gives deterministic serialization within the canonical grammar, avoids collisions with late authored IDs and keeps expression sharing explicit. Two distinct expressions cannot claim the same ID. The compiler's canonical names remain independent of authored names.

The differences are intentional:

- A literal zero can eliminate a branch. A parameter that affects live output remains editable and keeps its binding at zero. Spatially uniform bump heights have no effect at any value, so their unused bindings disappear.
- Two parameters with the same number are still independent. Reusing one expression explicitly shares it.
- Two paints may share a facet sample while having different palettes and finishes.
- Imported data is validated at the boundary. Internally produced immutable values retain identity and need not re-enter the full import path.

`ownership.mts` supplies one immutable construction proof. Expressions, normalized recipe parts and image resources borrow through that proof; recipe/resource modules separately remember which values passed their own validation. Arbitrary frozen caller data still crosses validation and isolation. A canonical recipe contains independent `mapping`, numeric `style` and expression `palette` records. Numeric edits reuse unchanged palette/mapping objects; palette edits preserve owned color roots and snapshot raw colors as one group. A complete owned palette can be borrowed directly. Shared style data never merges independently editable paint nodes.

`foldGraph` exposes a memoized, source-observing traversal for another interpretation. Each authored node is visited once in that traversal; numeric semantics stay in the interpreter. Compiler lowering uses this fold. Incremental CPU preparation uses the same signature-owned reference mapping while retaining prepared source slots across requests for additional roots. It does not change what an ordinary source-observing fold visits.

One immutable graph owns one incremental CPU preparation: source-slot point functions, scalar structural representatives, a structural-key map and its requested single-root samplers. A root request prepares only reachable slots not already prepared for that graph. Its field algebra owns literal-specialization metadata and shared image reconstructions. Transform inverses are calculated when their source point is prepared, with no additional inverse cache. Patched graph revisions own independent preparations.

Every sampler call creates a fresh normalized context and sample memo. Single-root calls preserve their existing boundary. An explicit output record shares that boundary across all requested scalar, color and domain results, so overlapping dependencies compute once for the whole output set. The result record and its samples are immutable; caller selection records and contexts are not retained. Hashing and graph traversal occur during preparation, never during repeated sampling. The v60 paired measurements (`docs/history/0.60/roots60.json` in the source archive) include an overlapping-root workload, mixed image outputs and a single-root control; they are CPU observations, not a frame-rate guarantee.

Canonical palettes also add graph nodes and cold validation work. The authoring receipt (`docs/history/0.60/values60.json` in the source archive) measured trusted-style paint construction/normalization at 12.19 → 24.35 µs, while roughness patches measured 4.39 → 3.05 µs. The adapter receipt (`docs/history/0.60/edits60.json` in the source archive) records mixed end-to-end edit results, including slower parameter edits in its two-paint workload. [SHARING.md](SHARING.md) reports these costs alongside the multiple-output sampling gains; the representation change is not a universal performance improvement.

### Construction owns the complete expression

A constructor snapshots raw caller data once, preserving repeated references
within that snapshot. Every copied record/array is frozen and receives the same
ownership proof. Reading an expression child and composing it elsewhere
therefore borrows that child instead of making an independent editable copy.
Caller-owned and merely caller-frozen objects still cross a fresh snapshot
boundary. No ownership table retains mutable author objects.

Coverage union/subtraction construct their complete algebraic expression before
that boundary. Interval masks own their repeated input once; chisels own their
shared domain once. This preserves named raw inputs and independent caller data
without adding operators, aliases or a mutable-identity cache.

`zone(name, mask, effects)` snapshots the whole application once. The same raw
root can appear in coverage, a channel and height without becoming three
editable controls. Shared raw descendants across distinct color/scalar roots
also stay shared. Existing owned inputs are borrowed. Equal but distinct raw
objects remain distinct. A zone name labels the application; only `named()`
assigns graph node IDs. This avoids silently forking a shared coverage root just
to rename it. Separate calls to `zone()` remain separate ownership boundaries;
compose an owned expression first when several applications should share it.

### Instances declare edit ownership

`instantiate(expression, {prefix, shared})` uses the same DAG rewrite as
`inDomain`. Local nodes are copied once, authored IDs are prefixed, and explicitly
shared subgraphs retain their identities. Unnamed editable nodes are copied too;
sharing is not inferred merely from a missing name or an equal current value.
Shared roots must be constructor-owned immutable expressions; their descendants
are borrowed by the same ownership proof. Raw templates remain snapshot inputs,
but raw shared roots fail immediately. There is no cache of mutable caller
identities. `named(id, rawExpression)` supplies a one-time ownership boundary
before that returned expression is composed and shared. `graphExpression`
provides the corresponding ownership boundary for stored graph documents.
The final graph validator still rejects collisions between instances with the
same prefix. Ordinary functions remain the reusable authoring abstraction.

### Height is differentiated before application

`surface.bump(input, height)` adds the height's analytic first differential to
the surface's unresolved slope. This exposes a semantic connection already
missing from the representation: one scalar can now drive pigment, finish and
detail. A varying height mask participates in the product rule, while existing
`relief` modulates an already-computed slope. Those operations remain distinct.

Shader generation tracks the ancestors that need differentials. Other scalar
paths retain their value-only form. A demanded noise node computes value and
gradient from one set of lattice corners, and its value remains shared with
color or finish consumers. Root rest-coordinate tangents originate in raster
derivatives; subsequent supported operations apply analytic chain rules.
Accumulated slopes pass through the existing normal resolve once. Bump does not
perform geometry displacement or choose filters for its inputs. Explicitly
filtered image readers supply a reconstructed value and matching partials;
procedural noise remains point sampled.

### Preserve analysis and binding work across edits

The compiled topology owns one latest analysis entry per canonical node. Each entry records its relevant value input and child-result identities. A roughness or palette edit therefore preserves scalar intervals, composed domains and opacity bounds. Changing a parameter, opacity or ancestor transform invalidates the affected dependent results, including descendants whose own node objects did not change. Value revisions still walk the canonical nodes to bind values and check dependencies; reuse avoids repeating unchanged numerical work.

`patchGraph` validates requested keys against editable fields and invokes the signature's value normalizer with the complete current node plus patch. Already validated literals and reference ports remain intact. Consequently a numeric paint edit keeps its palette-reference record, and a ramp-position edit keeps its color-reference list while still checking stop-count agreement. All replacements validate before a new graph is published; normalized no-ops return the existing graph.

Uniform preparation follows the same boundary. Within a shared structure, it compares the previous and current inputs of each binding group. Roughness updates the finish vector, a color-node edit updates linear coordinates, and field scale updates one float. Unchanged rotation, seed and matrix inputs skip their derived work. Full shader creation still requests the complete layout. The analysis cache keeps no previous-plan chain; explicit editor history has separate ownership.

## Cache ownership

There is no general cache service or serialized-graph key registry. Ownership
determines reuse; immutable inputs remove the need for manual invalidation.
Weak keys prevent a table from keeping its key alive, but do not make every
retained value free: a live topology can still own its latest analysis inputs.

| Derived state | Owner/key | Retention and reason |
| --- | --- | --- |
| Ownership proofs, normalized values | Weak object identity | Establish immutable construction/validation, rather than trust arbitrary frozen inputs |
| Graph topology and expression/document conversion | Weak graph or owned-expression identity | Slots and reified expressions are bounded by node count; preserve named sharing |
| Compiled plan | Weak immutable graph identity | Reuse the complete result for that revision |
| Lowered structure and bound nodes | Weak topology and source-node identities | Reuse topology across value patches without keeping an edit-history chain |
| Domain/range analysis | One latest entry per compiled slot | Reuse unchanged numerical results; replacement never links to an older entry |
| Prepared CPU points and scalar interning | One preparation per weak immutable-graph key | Each reachable source slot prepares once across roots; exact scalar representatives remain available for later root requests |
| CPU sample results | Fresh map per sampler invocation | Explicit multiple outputs share one map; it is discarded after that call |
| Literal metadata and image reconstruction functions | The graph preparation's field algebra | Shared prepared frames/resources/policies reuse one reconstruction; production sampling creates the algebra instance per graph |
| Transform inverse | The prepared domain closure | Compute once at preparation; no separate inverse-matrix cache |
| Image pyramids | Weak immutable resource identity | Share derived filtering data outside serialized graph data |
| Image channel ranges | The resource's existing weak ownership registry | At most three lazy immutable min/max pairs; mappings, filters and fresh topologies reuse them |
| Mark zone sample values | One bake, indexed by zone and sample generation | Only touched zones are sampled; advancing a sample invalidates all old values in constant time |
| Execution inspection | Weak compiled-structure identity | Nodes/edges/source IDs only; no image payload or graph history |
| Atelier paint view | Weak paint-node key, one latest view plus three current color-node references | Reuse current derived labels/controls without a nested map of past field or graph revisions |
| GPU image table and paint pair | Explicit texturing-system/material ownership | Borrower counts and deterministic disposal release graphics resources |

The adapter clears a disposed handle's texture-valued uniform slots before
releasing resources, including slots retained by Three's cached programs. Other
borrowers keep their own slots and ownership counts. The paint owner clears both
its texture pair and pending supplied pixels on disposal; `top` and `wall` become
null and `bytes` becomes zero. Historical build statistics remain inspectable.
Disposal still attempts every release if a listener throws.

### Reuse a whole composition in another frame

`inDomain(expression, frame)` binds a composition's implicit rest frame. It applies to scalar fields, color expressions, facet samples and surfaces. It preserves shared references and existing transform chains. An omitted frame is the identity binding. It does not flatten chains by multiplying matrices.

For a field function `f` and a frame mapping `T`, the intended mathematical action is evaluating `f` in `T`'s coordinates. In implementation, transforms are retained as an ordered expression so floating-point evaluation and derivative conventions remain explicit. Points use the affine transform, position differentials and pixel-footprint vectors use its linear part, and normals use the inverse transpose with normalization. CPU calculus directions and pixel-footprint vectors remain separate even though the same affine map transports them.

Surface mixing remains a parameter operation. For mask `m` clamped to `[0,1]`, it interpolates linear RGB, roughness, metalness, clearcoat, opacity and the authored slope pair. It does not solve optical scattering between physical layers. The final normal is resolved after slope composition. The mathematical distinction and source papers are documented in `docs/RESEARCH.md` in the source archive.

## Application structure

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Typed algebra and pure graph modules | Operation signature, immutable data, validation, interpretation, lowering | DOM nodes, graphics contexts, reactive UI state |
| Three adapter | GPU texture/material objects and uniform bindings | The accepted editor document, selection, source drafts |
| Typed composition commands | Pure graph transformations, shared-field editing, mask inspection | Rendering or browser APIs |
| Solid editor model | Accepted graph, reset baseline, derived plan, selection, unapplied source draft, coalesced editing | Shader semantics or renderer lifetime |
| Document history | Bounded before/after document references and undo/redo position | JSON copies, source drafts or GPU objects |
| Session store | Debounced local serialization, restoration and save status | Undo history, shader semantics or renderer lifetime |
| Solid components | Controls and accessible rendered state | A second manually synchronized DOM model |
| Effect graphics session and stage | Renderer attempts, preparation resources, controls, capture lifetime | Inspector DOM or graph reconstruction |
| Effect browser I/O | File reading, clipboard errors, download URL lifetime | Material/graph semantics |

The editor keeps the accepted graph and draft source distinct. A user can keep an unapplied JSON draft while continuing to edit the live composition. A failed validation or adapter commit leaves the accepted graph unchanged. Source serialization occurs on demand rather than on every slider event. Paint views hold canonical style/mapping and palette-reference records. One latest view per paint-node identity records the three currently referenced color nodes; a changed mapping or color replaces that entry. Returning to an older graph can recompute its view, and does not promise historical view-object identity. Controls patch numeric style/mapping values or the referenced color node directly. Preset and reseed commands remain explicit operations. `lab/examples.mts` stores a label and ordinary graph factory once, shared by the UI and exported examples. It imports composition commands; the commands do not import the gallery or its example modules.

Continuous value updates use one ordered patch-merge operation for frame batches and gestures: independent fields combine, and the last supplied value at the same field wins. A gesture applies its accumulated accepted patch to its starting graph, rather than building a new chain of intermediate documents. Returning to the original values therefore returns the original graph by identity. A rejected patch never joins the accepted accumulation. This requires no document serialization or retained hash to detect a no-op.

`lab/history.mts` retains up to 100 transactions using immutable graph/baseline references and selected node IDs. A changed continuous gesture can commit several preview frames and still becomes one undo entry when it ends. Redo is invalidated only by a completed changed gesture. A return to the starting document leaves history intact. Undo and redo go through the same validated commit boundary; they preserve an unapplied source draft. The compiler does not own this history.

`lab/session.mts` saves the current graph, reset baseline, selections, active tab and source-panel state, including an unapplied draft. It keeps references while edits arrive, serializes after a 400 ms debounce, and flushes at lifecycle checkpoints. Session format 2 stores the baseline once, then current changed nodes and baseline-ID references. Restoration borrows unchanged normalized records and validates the whole resulting graph. The version-1 reader recovers equal same-ID baseline records once during migration; distinct IDs remain distinct. Undo/redo stacks and GPU resources are not persisted. A storage failure changes save status while the accepted in-memory document remains usable.

Solid removes manual text setters, option reconciliation, DOM row maps and whole-panel synchronization. Effects at the rendering boundary update an existing adapter handle only when one exists. The mathematical core remains independent of Solid and Effect.

## Graphics and browser resource ownership

The public adapter accepts explicit capability records: `TexturingEngine` for materials and uniform containers, `PaintTextureEngine` for atlas textures, and `CoordinateEngine` for rest-coordinate attributes. Their types select the required Three exports; a full module namespace remains compatible. The atelier passes named capabilities so the bundler can see the adapter's dependencies.

The graphics session has explicit idle, starting, ready, unavailable, lost, failed and disposed states. These states distinguish failure to obtain WebGL2 from failure after a context exists. A child scope owns each renderer attempt. Preparation resources belong to that attempt and close before the renderer. Capture work cannot survive the session that supplied its pixels.

The stage borrows the painted material; the texturing system owns it. The scene, camera and accepted graph survive a renderer retry. Atlas/material allocation is deferred until the renderer and its preparation succeed. When graphics are blocked, pure composition, import/export and source editing remain available without constructing the atlas.

Browser downloads acquire a Blob URL in an Effect scope, start the browser download and release the URL when the scope completes. Failure and cancellation take the same finalization path. File and clipboard operations return typed errors with a user-facing message and underlying cause. These operations use pinned Effect 4.1.2; ordinary arithmetic and uniform writes do not become fibers.

## Comparison with established systems

This is a comparison of documented capabilities and the design lessons implemented here. It is not an interoperability claim or a benchmark against those applications.

| Reference | Useful representation | Moonweave adopts | Still outside Moonweave |
| --- | --- | --- | --- |
| [MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.Specification.md) | Typed node graphs, shader semantics and target-specific generation | Explicit sorts/ports, shared structure, renderer boundary | MaterialX import/export and standard node library |
| [Open Shading Language](https://open-shading-language.readthedocs.io/en/latest/intro.html) | Shading programs with renderer-interpreted closures | Separate pattern data from eventual shading, explicit coordinate semantics | OSL execution, general scattering closures and offline path tracing |
| [Substance Designer](https://github.com/AdobeDocs/substance-3d-designer.en/blob/main/help/getting-started/workflow-overview/workflow-overview.md) | Reusable graph instances, exposed parameters, image and value graphs | Reusable functions, values distinct from sampled fields, deliberate parameter ownership | General image processing, bakers, Substance file compatibility |
| [Blender node groups](https://docs.blender.org/manual/en/5.1/interface/controls/nodes/groups.html) | Explicit group inputs/outputs, reusable subgraphs | Composition with ordinary functions and shared expression values | A visual node editor, authored group assets, Blender interchange |
| [Houdini Copernicus](https://www.sidefx.com/docs/houdini/copernicus/intro.html) | GPU image/geometry processing, layer and geometry connections | Explicit meanings for different kinds of data | Image/volume export, geometry processing, simulation |
| [PBRT texture interfaces](https://www.pbr-book.org/4ed/Textures_and_Materials) | Functions of coordinates and texture footprints | Domain mapping, derivatives, field/material separation | A general CPU texture/shading implementation or spectral renderer |
| [Three's WebGPU/TSL path](https://threejs.org/manual/pages/webgpurenderer) | Node materials and a distinct rendering backend | An execution-plan boundary suited to another backend | A TSL/WGSL/WebGPU backend today |
| [Solid](https://docs.solidjs.com/advanced-concepts/fine-grained-reactivity) | Dependency-tracked signals and derived computations | Actual typed Solid editor/components | No reactive-framework requirement in the surface package |
| [Effect](https://effect.website/docs/v4/resource-management/scope) | Typed effects, resource scopes and interruption | Actual scoped renderer/browser lifetimes | No Effect runtime in the pure core or shader hot path |

The strongest next expansion would be a second field implementation or a baking interpreter with the same coordinate, color, derivative and sampling contracts. It would exercise the abstraction in another renderer. Adding a catalog of unimplemented node kinds would not do that.

## Evidence and limits

The release verification record separates type checks, graph laws, adapter state, native shader rendering, browser editor interaction and timings. They answer different questions. In particular, native Mesa shader success does not demonstrate that a managed browser can create a WebGL context; the latter reports its actual creation failure in the UI.

See `docs/VERIFICATION.md` in the source archive, `docs/GRAPHICS.md` in the source archive and the paired CPU benchmark reports for the measured results and unverified cases.

## Shared image reconstruction

Image storage and image sampling have separate identities. The compiler, CPU
evaluator and shader agree on a reconstruction key
`(image node, domain node, address mode, filter)`; channel selection projects
that shared result. A color reader plus three scalar channels therefore shares
one reconstruction with a read ceiling of 4, 8 or 64 according to its filter.
Distinct editable nodes retain independent bindings even when their current
data match. The CPU graph preparation owns its image/domain reconstruction
functions; a fresh memo belongs to each single- or multiple-output sample.
Neither retains sample contexts or an edit-history chain.

An immutable resource weakly owns a derived mip pyramid. Each destination cell
averages overlapping source cells and rounds to float32; dimensions floor-halve
to one. This explicit treatment retains odd rows and columns. The Three owner
uploads that pyramid once per image identity using nearest float storage.
Explicit texel reads reconstruct values and partials together, without a
float-linear filtering extension or driver-defined anisotropy. Changing a
resource descriptor replaces storage; changing reader placement or policy can
reuse storage.

Scalar range analysis similarly belongs to the immutable image, not each reader.
The image construction registry holds a lazy min/max pair for every requested
stored channel. Analysis of `R` readers over `P` texels therefore costs
`O(CP + R)`, where `C ≤ 3` is the number of requested channels, instead of
`O(RP)`. Zero addressing widens a reader's range to include zero without changing
the shared summary. Replacing image data creates a new resource and a new summary;
reusing an older resource reuses its exact bounds. Color-only images pay no range
scan, and no graph, revision chain or serialized statistics are retained here.

The CPU accepts an optional pixel footprint; an omitted footprint remains a
point query. The GPU derives its footprint from the unwrapped domain's screen
differentials before addressing. Trilinear filtering chooses scale from the
major footprint extent. Anisotropic filtering uses its principal axes and up
to eight midpoint taps, widening the minor filter when necessary to respect
that cap. Zero addressing extends finite marks with zero, and virtual coarse
levels widen and attenuate terminal reconstructions so their mass does not
turn into an infinite mean plateau.

Partials hold footprint, LOD and tap configuration fixed. This supports the
existing field chain and product rules within one selected reconstruction;
it does not differentiate camera-dependent filter selection. Tap-count changes
are discrete, and the bounded line approximation is not an exact pixel
integral or EWA. Filtering also does not commute with multiplication. Packed
control resources can retain correlated authored decisions by storing
`coverage * deposition` before reconstruction; the inscription study uses that
channel directly as height. General nonlinear expression filtering remains
outside this image-reader contract.

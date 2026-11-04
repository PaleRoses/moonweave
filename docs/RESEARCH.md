# Research and architectural decisions

## Release 0.62: reduce work at its semantic owner

This pass studied the current egglog 14 APIs and established compiler, renderer,
image-library and sparse-accumulator implementations, then measured the relevant
Moonweave paths against the immutable 0.61 source. The release measurements and
limitations are recorded in the full source archive at `docs/VERIFICATION.md`.

| Primary source | Applicable idea | Moonweave decision |
| --- | --- | --- |
| [egglog 14 release and extraction APIs](https://egglog-python.readthedocs.io/latest/changelog.html) | Shared DAG costs, explicit scheduling, separate analyses and extraction | Retain greedy-DAG extraction and the independent acceptance gate; use a finite finish-demand phase before equation search |
| [Better Together: Unifying Datalog and Equality Saturation](https://arxiv.org/abs/2304.04332) | Relational analyses can cooperate with equality saturation | Generate demand rules from the typed effect manifest; keep source terms in a separate sort so rewritten output cannot create new analysis inputs |
| [PBRT 4e image-texture ownership](https://www.pbr-book.org/4ed/Textures_and_Materials/Image_Texture) | One image preprocessing result can serve different texture mappings | Keep scalar range summaries with their immutable resource, independent of graph readers and revisions |
| [OpenImageIO image statistics](https://openimageio.readthedocs.io/en/stable/imagebufalgo.html#image-comparison-and-statistics) | Explicit per-channel minimum/maximum summaries | Compute only requested channel ranges; widen zero-addressed reader ranges separately |
| [SuiteSparse:GraphBLAS sparse accumulators](https://sources.debian.org/src/suitesparse-graphblas/7.4.0%2Bdfsg-1/Source/GB_AxB_saxpy3.c) | A generation marker invalidates prior scratch entries without clearing the universe | Use bake-local value/generation arrays for zone sampling; the image budget proves the counter cannot wrap |
| [Briggs and Torczon, sparse sets](https://www.dcs.gla.ac.uk/~pat/ads2/papers/sparseSets.pdf) | Representation should make frequent clears independent of universe size | Test a local-touch workload with many active zones, separately from spatial culling |
| [Reproducible Builds archive guidance](https://reproducible-builds.org/docs/archives/) | Stable membership, order and metadata | Export an explicit portable source tree and rebuild every distribution output byte for byte |

The image-analysis term changes from `O(readers × texels)` to
`O(requestedChannels × texels + readers)`, with at most three stored channels.
This also removes repeated pixel scans when independent optimizer candidates
reuse the same authored resource. An owned summary is a pair of bounds, not a
graph cache, historical revision chain or serialized image copy.

Painting uses the support law
`support(brush × zone) ⊆ support(brush) ∩ support(zone)` before spatial binning.
Filtered supports include their reconstruction footprint. The candidates retain
authored order, and the numerical deposition formulas are unchanged. For one
localized zone per 16×16 tile, the measured candidate family changes from
`256N²` tests to `256N`; dense overlapping contributions still require their
actual work.

Finish demand is a four-bit context. Each source surface can be projected under
at most 16 such contexts. A write removes the overwritten component from its
child's demand; componentwise operations pass the remaining demand to their
surface inputs. This bounds the projection state space. It does not make general
equality saturation linear or prove globally optimal extraction. Search retains
its budgets, and candidates must independently preserve all six symbolic surface
observations and improve the compiled cost without a regression.

These are local adaptations of the described ownership, dataflow and accumulator
techniques. This pass copies no implementation from PBRT, OpenImageIO,
SuiteSparse, LLVM or egglog. The existing adapted color/spectral code retains its
separate notices. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) inventories
those sources and the installed dependencies.

## Earlier decisions and their rationale

Moonweave 44 introduced the compositional surface algebra. Revision 45 separates reusable structure from editable values and removes repeated work along the edit path. Revision 47 unifies the language signature and interpreters, replaces the imperative atelier with Solid/TypeScript, and manages browser resources with Effect. Revision 48 studies actual T3 Code and established compiler/editor/library implementations, then removes repeated numerical work, narrows engine dependencies and adds reversible, persistent editing. Revision 51 adds independent procedural scalar fields and a color sort, removes mandatory paint/atlas assumptions, and validates generated color values against CPU evaluation. The original painted field remains `filled-facets/11`; materials are expressions over domains, sampled fields, masks, color and finish. The decisions below are Moonweave's implementation choices informed by the cited primary sources. They are not claims of MaterialX, OSL or TSL interoperability.

## 1. Typed expressions and a renderer boundary

[MaterialX's specification](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.Specification.md) distinguishes pattern data, shader semantics, materials and rendering targets. Its node graphs are typed directed acyclic graphs. [Its shader-generation guide](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/DeveloperGuide/ShaderGeneration.md) describes dependency ordering, intermediate graph construction and externally bound uniforms.

**Decision:** retain a small, versioned JSON graph with explicit scalar, domain, facet-sample and surface types. Validate connections before code generation. Lower it to a reachable, ordered execution plan. Bind editable values separately from structure. There is one Three adapter; the authoring core imports no renderer and owns no GPU objects.

[PBRT's texture/material separation](https://www.pbr-book.org/4ed/Textures_and_Materials) treats a texture as a function over a domain, including functions that consume other textures. Materials use those values to determine scattering parameters.

**Decision:** a facet sample and the style applied to it are separate nodes. Two paints can explicitly reference one sample. Palette changes cannot regenerate the atlas, and adding a second palette does not require a second sample when its domain is shared.

## 2. Functional composition without a second programming language

[thi.ng shader-ast](https://github.com/thi-ng/umbrella/blob/develop/packages/shader-ast/README.md) demonstrates an embedded typed expression representation with dependency analysis and multiple code-generation targets. [OSL](https://github.com/AcademySoftwareFoundation/OpenShadingLanguage/blob/main/src/doc/intro.md) similarly separates shader expressions from the renderer's eventual evaluation of scattering closures.

**Decision:** provide pure constructors for scalar arithmetic, masks, domains and surfaces. Constructors can be nested normally and reused by reference. The serialized representation contains data rather than JavaScript callbacks. A small domain-specific algebra is enough for this release; adopting an entire general-purpose shader language would substantially expand the implementation and dependency surface.

Constants and editable parameters have different contracts. A literal zero can prove an expression dead. A parameter currently equal to zero must remain editable without rebuilding the shader. Identical initial values do not establish shared ownership. Explicit references establish sharing.

## 3. Coordinates carry derivatives

[PBRT's texture-coordinate interface](https://www.pbr-book.org/4ed/Textures_and_Materials/Texture_Coordinate_Generation) carries coordinate differentials alongside mapped coordinates. [OSL's transform and derivative definitions](https://open-shading-language.readthedocs.io/en/v1.13.12.0/stdlib.html) distinguish points, vectors and normals: their transformation rules differ.

**Decision:** an affine domain transforms positions by the full matrix, position differentials by its linear part, and normals by the inverse transpose. Domain composition preserves these rules. Scalar CPU evaluation propagates differentials through the supported expression algebra. Rest-coordinate attributes retain the material frame across mesh transforms and deformation.

This release does not introduce nonlinear domain warps. A later warp needs a Jacobian and a filtering contract. Calling an arbitrary callback from the graph would conceal both.

## 4. Filter each projection before mixing it

[PBRT's sampling discussion](https://www.pbr-book.org/4ed/Textures_and_Materials/Texture_Sampling_and_Antialiasing) separates estimating the footprint from removing frequencies that footprint cannot resolve. [Its image-texture chapter](https://www.pbr-book.org/4ed/Textures_and_Materials/Image_Texture) explains isotropic and anisotropic filtering from coordinate derivatives.

**Finding:** revision 43 multiplied a mixed facet value by a mixed visibility factor. This allowed a projection whose detail was already unresolved to influence another projection's result.

For weights `wᵢ`, facet values `hᵢ`, resolution factors `kᵢ`, and neutral value `μ`, the corrected expression is:

```
μ + Σ wᵢ kᵢ (hᵢ − μ)
```

The old expression was:

```
μ + (Σ wᵢ hᵢ − μ) (Σ wᵢ kᵢ)
```

With `w=(0.5,0.5)`, `h=(0.9,0.5)`, `k=(0,1)` and `μ=0.5`, the corrected value is `0.5`; the old value was `0.6`. Thresholded accents also need their own per-projection treatment. Atlas mipmaps remain enabled.

## 5. Compose slopes, resolve the normal once

[Mikkelsen's surface-gradient framework](https://jcgt.org/published/0009/03/04/) addresses bump-map composition, procedural coordinates and triplanar projections in a common gradient formulation.

**Decision:** a surface expression carries a screen-space slope pair alongside linear RGB and finish channels. Surface composition interpolates these slopes, then the adapter resolves the final shading normal once. Clearcoat uses the same resolved relief convention.

Moonweave's atlas BA channels encode authored slopes. They are independent of the quantized facet-pigment channel. A spatial blend of slopes is an artistic interpolation, not the derivative of a blend of height fields. For actual heights,

```
∇((1−m)h₀ + mh₁) = (1−m)∇h₀ + m∇h₁ + (h₁−h₀)∇m
```

The last term requires meaningful heights. This release deliberately makes no such height claim. Its `relief` operator scales the authored slope field.

## 6. Keep parameter blending distinct from optical layering

[MaterialX's PBR nodes](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.PBRSpec.md) give scattering operations their own semantics. [Filament's material system](https://google.github.io/filament/main/materials.html) describes the meaning of individual PBR parameters.

**Decision:** `surface.mix` interpolates linear RGB, roughness, metalness, clearcoat, opacity and authored slopes. Its mask is clamped to `[0,1]`. This is a surface-parameter blend evaluated by Three's existing physical material. It is not a BSDF-mixture integrator, a layered dielectric solver, or a thin-film interference model. Finish overrides are explicit operations rather than additional preset-specific shader branches.

## 7. Preserve painterly hierarchy and coherent motion

[Hertzmann's painterly rendering work](https://mrl.cs.nyu.edu/publications/painterly98/) builds paintings from broad strokes toward selectively placed detail. [Bénard and colleagues' coherent stylization work](https://graphics.cs.kuleuven.be/publications/BLVLDT10DNPCS/index.html) studies the tension between a two-dimensional style and motion through a three-dimensional scene.

**Decision:** keep the existing filled angular facets, broad pigment, sparse accents and quiet underpainting. Preserve the deterministic atlas bytes. Rest-space projection is the chosen motion convention for creatures. This release does not implement either paper's full algorithm, and it does not claim complete screen-space stylization invariance.

## 8. Stochastic tiling is a separate experiment

[Heitz and Neyret](https://eheitzresearch.wordpress.com/722-2/) analyze the loss of contrast and altered color statistics caused by blending random texture patches. [Deliot and Heitz](https://eheitzresearch.wordpress.com/738-2/) address practical histogram transforms and mip-level color deviations. [Burley](https://jcgt.org/published/0008/04/02/) and [Mikkelsen's practical hex-tiling work](https://jcgt.org/published/0011/03/05/) provide related approaches. [Unity's own prototype notes](https://unity.com/blog/engine-platform/procedural-stochastic-texturing-in-unity) limit its intended use to stochastic or near-stochastic input textures.

**Decision:** defer stochastic retiling. Moonweave's angular shapes and directional rhythm are intentional. Additional patch samples and blending could soften that grammar. A useful future experiment would compare repetition reduction, facet sharpness, memory and sample cost at equal viewing conditions. It should not be enabled merely because randomized texture tiling exists.

## 9. Modern renderer research does not erase the current adapter contract

[Three's material documentation](https://threejs.org/docs/pages/Material.html) restricts `onBeforeCompile` to `WebGLRenderer` and points toward node materials and TSL. [The WebGPU migration guide](https://threejs.org/manual/pages/webgpurenderer) explicitly states that these shader hooks do not carry into `WebGPURenderer`; it also continues to recommend `WebGLRenderer` for applications specifically targeting WebGL 2.

**Decision:** isolate the WebGL adapter and test its supported Three endpoints. The pure graph and its execution plan provide a future backend boundary. A TSL, WGSL, MaterialX or offline-baking backend would be a separate implementation with its own semantic tests. None is silently advertised as already supported.

## 10. Editing has its own representation

[Three's update guide](https://threejs.org/manual/pages/how-to-update-things.html) distinguishes ordinary uniform-value edits from changes that require new shader programs. Keeping the GPU program stable is only half the work: revision 44 still rebuilt and validated the CPU graph repeatedly for each slider event.

**Decision:** retain one immutable graph topology and one compiled structure across value revisions. `patchGraph` changes actual source nodes and preserves the rest by identity. `materialGraph` and `compileGraph` recognize their own immutable inputs; external documents still enter through validation. The adapter packs and writes only changed uniform groups. Mapping and style have independent value validators; the legacy recipe composes them rather than serving as the graph's internal representation.

[Solid's batching model](https://docs.solidjs.com/reference/reactive-utilities/batch) groups related updates before downstream work, and its [fine-grained reactivity description](https://docs.solidjs.com/advanced-concepts/fine-grained-reactivity) focuses on the parts that actually depend on a changed value.

**Revision 45 decision, replaced in 47:** the DOM atelier used manually keyed paint/mask rows. Revision 47 now uses Solid itself: signals, derived memos, keyed components and strict TypeScript JSX compiled by Solid's official compiler. Continuous edits still coalesce into one material commit per frame. JSON remains an import/export representation produced on demand. The graph is authoritative; constants, shared references and independent parameters survive ordinary edits.

[esbuild's ESM splitting](https://esbuild.github.io/api/#splitting) shares code between entry points. This matters for identity as well as size: separately bundling the core and adapter produced separate internal graph caches.

**Decision:** publish ESM entries backed by shared chunks. A graph constructed through the core entry keeps its identity when passed to the adapter. Shared topology records contain no predecessor graphs, and value-node caches are weak; an active graph does not retain a chain of slider revisions.

The paired benchmark includes fresh imports and first compilation as well as repeated edits. Preparing reusable metadata adds a first-compilation cost. That tradeoff is reported alongside the improvement to repeated edits rather than hidden behind cached lookup ratios.

## 11. Context availability and rendering correctness are different questions

[Three's renderer contract](https://threejs.org/docs/pages/WebGLRenderer.html) requires WebGL2 in the atelier's installed revision. The browser's [context-creation error event](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextcreationerror_event) can explain why creation failed, while Three's shader hook can report compilation/link errors after a context exists. [Khronos's lifecycle specification](https://registry.khronos.org/webgl/specs/latest/1.0/#5.15.2) distinguishes context loss from restoration.

**Decision:** revision 46 gives graphics its own lifecycle, independent of the immutable graph and stage scene. Context creation, preparation, shader compilation, drawing and context loss have distinct reports. Retry and restoration recreate renderer resources without replacing the graph or camera. A successful first frame enables capture. GPU-generated lighting is regenerated after restoration.

The managed browser's actual failure is `GL_VENDOR = Disabled` / `GL_RENDERER = Disabled`. It does not establish that the user's browser shares that restriction. A lower graphics workload cannot enable a disabled API, and a static image must identify itself as a reference instead of implying it reflects live edits. Browser success and context-restoration tests remain separate from native shader evidence and lifecycle unit tests. [GRAPHICS.md](GRAPHICS.md) records the diagnosis procedure, supported recovery, and backend alternatives.

## 12. One language signature, several interpretations

MaterialX's typed graph representation and shader-generation boundary provide a useful reference for a small embedded language. The useful property is agreement between representations: a node's input sorts, result sort and editable fields must not drift across the validator, authoring API, serializer, optimizer and renderer.

**Decision:** `src/core/algebra.mts` owns the operation signature. The graph's expression types and serialized-node types are derived from that signature. Its reference ports drive traversal, remapping and validation; its literal/value separation drives edit eligibility and structural identity. A memoized DAG fold supplies the shared traversal for CPU interpretation and compiler lowering. Different interpretations retain their different numerical rules. This does not fuse validation, evaluation and rendering into one effectful function.

The CPU interpretation compiles point functions once per immutable graph/root and then samples those functions with a fresh context and shared-node memo. A per-sample generic metadata walk was measured and removed during this revision. The compiled interpretation reduces repeated work, but increases import-plus-first-sample cost. [The paired report](history/0.47/performance47.json) preserves both measurements, along with edit timings, rather than treating abstraction alone as a performance claim.

`inDomain(expression, frame)` binds the implicit frame of a complete composition. Its masks and sampled fields move together. Shared subexpressions stay shared, and nested transforms retain their evaluation order. The implementation does not pre-multiply matrices or reassociate floating-point expressions merely to make the graph shorter.

## 13. Use Solid and Effect where their contracts apply

[Solid's reactivity model](https://docs.solidjs.com/advanced-concepts/fine-grained-reactivity) records dependencies between signals and computations. Its [TypeScript setup](https://docs.solidjs.com/configuration/typescript) requires preserving JSX for the Solid compiler. [The official JSX preset](https://github.com/solidjs/solid/tree/main/packages/babel-preset-solid) emits Solid runtime operations.

**Decision:** use stable Solid 1.9.18 and `babel-preset-solid` 1.9.16 with compatible Babel 7.29.7, pinned in the lockfile. The atelier has typed components and a typed editor model. Manual option reconciliation, row maps, text synchronization and whole-inspector sync functions are removed. Solid does not participate in the public surface library or generated shader code.

[Effect 4's scope model](https://effect.website/docs/v4/resource-management/scope) associates resource acquisition with finalization. Finalizers run when the scope closes, including interruption and failure, and dependent resources release in reverse order.

**Decision:** pin Effect 4.1.2 and use actual acquisition/release scopes for graphics attempts, preparation resources, capture and browser download URLs. Files and clipboard operations have an explicit typed error channel. The stage receives canvas/viewport references and emits typed state; it no longer reaches into inspector DOM. A graphics failure cannot replace the accepted graph. Numeric editing, atlas generation and shader evaluation remain ordinary pure functions or direct adapter calls.

## 14. Compare the representation, not a screenshot of the interface

[Substance Designer's workflow](https://github.com/AdobeDocs/substance-3d-designer.en/blob/main/help/getting-started/workflow-overview/workflow-overview.md) distinguishes reusable graph instances, exposed controls and image processing. Its [function graphs](https://experienceleague.adobe.com/en/docs/substance-3d-designer/using/substance-function-graphs/function-graphs) operate on values and mathematical expressions. [Blender's node groups](https://docs.blender.org/manual/en/5.1/interface/controls/nodes/groups.html) expose inputs and outputs for reuse across larger trees. [Houdini Copernicus](https://www.sidefx.com/docs/houdini/copernicus/intro.html) processes images and geometry in GPU graphs and exports images or volumes.

**Decision:** retain a value/field/surface distinction and reusable ordinary functions, with explicit parameter ownership and coordinate binding. A large visual node canvas is not required to make that representation composable. Moonweave still has a much narrower execution vocabulary than these systems. It does not offer general image filters, image baking, geometry processing, authored node-group assets or their file-format interchange. The comparison in [ARCHITECTURE.md](ARCHITECTURE.md) records what was adopted and what is absent, so reuse claims remain testable.

## 15. Study the operation boundary in actual editor code

The T3 Code comparison used the official `pingdotgg/t3code` repository at commit `cefb544af3c98224874419198c0359b652ca3c94`, including these source files:

| Source | Relevant mechanism | Moonweave decision |
| --- | --- | --- |
| [composer-undo-grouping.ts](https://github.com/pingdotgg/t3code/blob/cefb544af3c98224874419198c0359b652ca3c94/apps/web/src/composer-undo-grouping.ts) | Explicit history boundaries distinguish kinds of document change. | Group preview frames into one completed gesture; finish the gesture before a preset, reseed or structural command. |
| [threadUndo.ts](https://github.com/pingdotgg/t3code/blob/cefb544af3c98224874419198c0359b652ca3c94/packages/client-runtime/src/state/threadUndo.ts) | A pure undo plan is distinct from executing its effects. | Pure history transitions propose a document; the existing validated material-commit boundary accepts it before history advances. |
| [projectEntities.ts](https://github.com/pingdotgg/t3code/blob/cefb544af3c98224874419198c0359b652ca3c94/packages/client-runtime/src/state/projectEntities.ts) | Derived entity/list updates preserve unchanged identities. | Keep immutable graph references and cache paint-style classification independently of field values. |

[CodeMirror's history implementation](https://github.com/codemirror/commands/blob/5b9bac974f2c4af3e20b045adef949667872ecad/src/history.ts) also treats history as transactions with explicit isolation and grouping. [Excalidraw's history](https://github.com/excalidraw/excalidraw/blob/dd2f8fc32b92cbf56f4abee6a0cf3b14681b4b55/packages/excalidraw/history.ts) distinguishes selection changes from changes that invalidate redo.

**Decision:** retain at most 100 before/after graph snapshots by reference. The snapshot includes the Reset baseline and selected graph nodes; the unapplied source draft stays separate. Selection, rejected actions and semantic no-ops do not consume graph history. Native text inputs retain their own undo. This implementation is specific to Moonweave's immutable graph; the referenced third-party source was inspected, not copied into the product.

The measured style-classification case is eight paints sharing one field across 60 field edits. Revision 47 serialized unchanged styles 480 times. Revision 48 performs zero such serializations. This is eliminated work, not a frame-rate estimate.

## 16. Analysis reuse follows real dependencies

[LLVM's new pass manager](https://llvm.org/docs/NewPassManager.html#using-analyses) distinguishes analyses a transformation preserves from those it invalidates. Its invalidation discussion also requires checking dependencies of cached analyses. [esbuild's architecture](https://github.com/evanw/esbuild/blob/main/docs/architecture.md) emphasizes avoiding representation round trips and full passes over unchanged structures, with immutable sharing across incremental builds.

**Decision:** the existing compiled topology owns one latest analysis entry per canonical slot. Entries compare the value that matters and child-result identities. Paint opacity participates in opacity analysis; palette and roughness do not. Transform analysis depends on the ancestor result, so a changed parent invalidates an unchanged descendant. Scalar intervals and dependent surface opacity change together. A failed intermediate analysis cannot make an unrelated revision reuse an invalid result.

This retains the canonical-node walk needed to bind/check a revision. It removes repeated matrix multiplication, float32 checks, inversion and interval work for unaffected dependencies. There is no retained chain of compiled revisions. [The focused paired report](history/0.48/performance-analysis48.json) records 0-, 8- and 24-transform cases, while [the broader report](history/0.48/performance48.json) includes small graphs and first-use costs. Cache setup has a cost; the evidence does not establish that every operation is faster.

Three already compares cached scalar/vector values before many GPU uniform calls; see its [r187 WebGLUniforms implementation](https://github.com/mrdoob/three.js/blob/r187/src/renderers/webgl/WebGLUniforms.js). Moonweave now skips unchanged work before that boundary: roughness writes only the finish vector; scale writes only one float; palette, rotation, seed and transform derivations run only when their inputs change. Complete shader creation still asks for all bindings.

## 17. Supply the capabilities a library actually consumes

[esbuild's tree-shaking contract](https://esbuild.github.io/api/#tree-shaking) depends on determining which declarations are used. [React Three Fiber's granular Canvas setup](https://r3f.docs.pmnd.rs/api/canvas) demonstrates explicit registration for tree-shaking. Moonweave's v47 atelier passed the entire Three namespace through both the material adapter and coordinate binding; the module escape retained unrelated exports.

**Decision:** expose narrow `PaintTextureEngine`, `TexturingEngine` and `CoordinateEngine` types. The atelier supplies named imports in records satisfying those types. Existing hosts can still pass a complete namespace. Both injection points must be narrow to obtain the measured reduction. The source and compressed sizes, compiler settings, source hashes and exact built-bundle match are recorded in [bundle48.json](history/0.48/bundle48.json).

T3's large preview panels use lazy imports, and [Solid provides lazy loading directly](https://docs.solidjs.com/reference/component-apis/lazy). That remains a possible future loading boundary. This release first removes code the current editor never uses and defers geometry/material construction until a usable renderer exists. A blocked context now creates zero geometry and does not request the atlas; successful retry constructs the latest selected specimen. This addresses measured startup work with the existing synchronous stage lifecycle.

## 18. Persist the document at a deliberate boundary

[Zustand's persist implementation](https://github.com/pmndrs/zustand/blob/main/src/middleware/persist.ts) and [its persistence contract](https://github.com/pmndrs/zustand/blob/main/docs/reference/middlewares/persist.md) make storage, versioning, partial persisted state and hydration explicit. The relevant idea is ownership of a saved document; Moonweave already has the reactive graph state it needs.

**Decision:** a small session adapter saves versioned graph/baseline references, selections, tab and the unapplied source draft. It serializes after a 400 ms quiet period and flushes at page lifecycle checkpoints. Loading validates both accepted graph and Reset baseline against the graph and shader-budget contracts. Storage errors retain the in-memory state and a retryable pending save. Undo stacks and graphics resources remain session-local. There are no new runtime dependencies in revision 48.

## 19. Put authored identity in the existing graph

[MaterialX's specification](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.Specification.md) defines named, typed graph elements and requires unique child names within a parent scope. [OpenUSD's `UsdShadeInput` source](https://openusd.org/release/api/input_8h_source.html) exposes a shading input through its underlying named, typed attribute. Both separate authored identity from the current value of an input.

**Decision:** add `named(id, expression)` across Moonweave's four existing sorts. It writes the graph-v1 `id` already supported by the document format; no new operator, metadata format or mutable control registry is necessary. Reusing a named expression shares one node, while independent expressions with duplicate IDs fail. A bounded postorder traversal reserves authored IDs before generating the remaining names. Entirely unnamed serialization stays byte-for-byte compatible, and compiler program keys remain independent of author names.

This is a scoped design lesson, not MaterialX or USD interoperability. Moonweave has a flat graph namespace. Reusable authoring functions should accept a unique prefix when independently instantiated in the same graph. Renaming does not change a scalar literal's structural semantics.

## 20. Preserve values that are already owned

[Immer documents semantic no-op identity](https://immerjs.github.io/immer/performance/): an update without a semantic change can return the original state and avoid downstream work. Its published historical timings are not a performance comparison for this release. Moonweave's existing private normalization table already proves ownership of immutable values; no proxy runtime or new state dependency is needed to use that proof.

**Decision:** constructors borrow normalized style/mapping values. Raw inputs, including arbitrary frozen caller objects, are still copied and validated. A style edit validates only supplied fields, shares an unchanged palette and returns the original style for a normalized no-op. Legacy recipe patches preserve their untouched mapping/style parts. Separate paint nodes keep independent editable identities even when their immutable style is shared.

The editor now reads those same canonical style/mapping references instead of synthesizing a legacy recipe and splitting it again. The examples registry owns labels and graph factories together. Its new Directional finish graph uses ordinary named expressions and the same exported API as a consumer.

The history correction follows the transaction boundary studied in section 15: accumulate accepted value patches against the gesture's starting graph, with later field values taking precedence. Returning to the start restores the original graph identity, so history needs no JSON comparison. Rejecting an invalid preview leaves the accepted accumulation unchanged; Redo is cleared only when a changed gesture completes.

[The paired revision 48/49 ownership report](history/0.49/performance-values49.json) records validation work, retained object identities and CPU timings separately. [The general edit report](history/0.49/performance49.json) checks the broader operation paths, and [the bundle report](history/0.49/bundle49.json) records the actual size tradeoff. These measurements do not establish a GPU frame-rate gain or globally minimal implementation.

## 21. Package boundaries are part of the public API

The revision 50 review checked [Node's package entry-point contract](https://nodejs.org/api/packages.html), [npm's file selection](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files), [the actual `npm pack` command](https://docs.npmjs.com/cli/v11/commands/npm-pack/), and [TypeScript's library-author guidance](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options). These distinguish a development checkout from an installable package, require deliberate public entry points, and explain why declarations must resolve in the consumer's module system.

The review also inspected the current primary manifests of [Three](https://github.com/mrdoob/three.js/blob/dev/package.json) and [Effect](https://github.com/Effect-TS/effect/blob/main/packages/effect/package.json), plus T3 Code's [architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) and [release workflow](https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md). Their relevant lesson here is explicit module, artifact and execution ownership. Their repository size or popularity does not establish the right architecture for this smaller library.

**Decision:** organize source into `core`, `paint` and `three` folders, with three public entry points. Keep authored declarations beside their modules and emit the algebra declaration from its typed signature. Build a release in `build/package/`, whitelist its contents, use real `npm pack`, and construct the portable ZIP from that exact inventory. Install the result into a fresh consumer and test the standalone core before supplying Three or its types. Historical screenshots, test logs, source implementations and app code remain in the complete source release. No dependency update or monorepo framework is needed for these corrections.

## 22. Choose an exact compositional law

[MLIR's canonicalization guidance](https://mlir.llvm.org/docs/Canonicalization/) favors local, cheap, convergent rewrites while keeping correctness independent of canonicalization. [LLVM's floating-point contract](https://www.llvm.org/docs/LangRef.html#fast-math-flags) makes reassociation an explicit relaxation because it can change results. [MaterialX's functional graph specification](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.Specification.md#functional-nodegraphs) separates a typed interface from its implementation.

**Decision:** retain the four existing sorts and apply the exact partial-map law for finish overrides. Later channel values take precedence, so `channels(channels(s,A),B)` lowers to `channels(s,A ⊕ B)`. This removes fully shadowed scalar work through existing reachability and preserves independently used branches. The operation's fixed channel order makes the nested and flat representations produce the same program. No generic rewrite engine, arithmetic reassociation or new graph node kind is introduced. Tests cover all 256 pairs of channel subsets, live bindings and actual adapter writes.

## 23. Edit the scalar context, not an inferred recipe

[Three's TSL documentation](https://threejs.org/docs/pages/TSL.html) describes mixing and one-minus as distinct operations. The distinction is also present in Moonweave's existing signature: the entire blend factor can be complemented independently from a region within that factor.

**Finding:** the editor previously understood only a root-level strength product. Wrapping the complete mask in a complement hid that strength from inspection; changing region then reconstructed a new default-strength mask. The reconstruction changed an authored expression the user had not asked to replace.

**Decision:** identify a unique editable coordinate path through the scalar context and retain its wrappers, multiplication order, strength, bounds and domains. Position/direction changes substitute the coordinate along a copied path for the selected blend. A literal remains a literal. Ambiguous products remain custom. In particular, `1 − a × r` must not be rewritten to `a × (1 − r)`. Behavioral tests sample the resulting masks and check other users of shared nodes.

## 24. Let fields exist independently of paint

Revision 51 follows the typed value boundary in [MaterialX's core specification](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.Specification.md) and [PBRT's texture interface](https://pbr-book.org/4ed/Textures_and_Materials/Texture_Interface_and_Basic_Textures). A scalar controls a color mixture; a color supplies a material; the same scalar can supply roughness. Constant and varying inputs use the same ports. The existing facet paint remains a producer of surfaces.

**Decision:** add a color sort, editable linear-RGB color values, color mixing, a color-based material constructor and one deterministic scalar field. Keep finish overrides in the existing `channels` operation. Decode `color.srgb` once at construction; store linear Rec.709 RGB reflectance in the graph. Reject implicit scalar/color/surface conversions. Ordinary JavaScript functions build reusable expressions, and `named` exposes their controls through existing graph IDs. The precise finite grammar and implemented capability matrix are in [GRAMMAR.md](GRAMMAR.md).

[MaterialX's standard-node notes](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.StandardNodes.md) put noise scaling and placement in the input coordinate network. **Decision:** keep scale, rotation and offset in the existing domain algebra; keep amplitude and thresholds in scalar arithmetic and ramps. Do not duplicate them as another collection of noise-specific knobs.

This boundary revealed two concrete dependencies in Moonweave: the editor unconditionally selected its first paint, and material creation always allocated the atlas pair. Both are removed. A graph with no paints has a nullable paint selection, ordinary source/history/session behavior and generic expression controls. Its live GPU plan has no facet sampler declarations or atlas allocation. Entering a paint graph acquires resources before committing it. Failed acquisition preserves the prior material.

## 25. Specify noise numerics and filtering separately

[MaterialX's actual GLSL noise library](https://raw.githubusercontent.com/AcademySoftwareFoundation/MaterialX/main/libraries/stdlib/genglsl/lib/mx_noise.glsl), [Perlin's reference implementation](https://mrl.cs.nyu.edu/~perlin/noise/index1.html), and [Jarzynski and Olano's GPU hash study](https://jcgt.org/published/0009/03/02/paper.pdf) provide different useful pieces: explicit integer hashing, smooth lattice interpolation and measured hash-quality tradeoffs. These sources are implementation references, not a claim that their complete systems have been imported.

**Decision:** Moonweave's scalar noise is one eight-corner value-noise octave, with quintic interpolation, nested PCG uint32 hashing and a documented 65,536-cell period. Coordinate hashes share intermediate work, using fourteen fixed hashes per sample. CPU integer operations and GLSL integer operations agree; interpolation precision differs. The GPU path requires WebGL2/GLSL ES3. Large coordinates lose spatial precision in float32, so recentering/rescaling remains the author's responsibility. This field is not Perlin noise and does not reproduce MaterialX or OSL sample values.

[OSL explicitly distinguishes noise ranges and filtering behavior](https://open-shading-language.readthedocs.io/en/latest/stdlib.html), while [PBRT separates footprint estimation from reconstruction filtering](https://pbr-book.org/4ed/Textures_and_Materials/Texture_Sampling_and_Antialiasing). **Decision:** give the new field a point-sampling contract. Propagate analytic CPU differentials through domains and color mixtures, including the mask's product-rule term. Do not equate those derivatives with antialiasing or silently fade a field to its mean. A filtered procedural field, image resources, non-affine warps and height-to-normal construction need explicit additional contracts. The existing facet atlas retains its own filtering.

Verification samples the actual generated color graph, packs GPU float bits into RGBA8 bytes, and compares them with the CPU interpreter. This is distinct from image appearance, shader compilation and browser context availability. Both pinned Three endpoints now use their own WebGL2 shader assemblers in native validation. New procedural and hybrid examples are rendered, and prior facet images are compared against revision 50.

## 26. Separate color coordinates from reflectance

[CSS Color 4's interpolation rules](https://www.w3.org/TR/2026/CRD-css-color-4-20261103/#interpolation-space), [Color.js interpolation](https://colorjs.io/docs/interpolation) and [its gamut-mapping documentation](https://colorjs.io/docs/gamut-mapping.html) distinguish a color coordinate, an interpolation path and a lossy output projection. The v51 bounded-reflectance Color sort could not preserve an out-of-gamut intermediate for further composition.

**Decision:** v52 stores extended linear RGB. Linear-light mixing remains the default; Oklab is explicit. Intermediates are not clipped. Generic material inputs and connected paint pigments project RGB into `[0,1]`; this projection is not perceptual gamut mapping. The original pigment kernel retains its artistic gain. The D65/Oklab coefficients in [the W3C reference code](https://www.w3.org/TR/2026/CRD-css-color-4-20261103/#color-conversion-code) form one table used by CPU math and generated GLSL. Conversion Jacobians propagate color and mask differentials; singular cube-root tangents have an explicit contract.

## 27. A palette is a field-valued interface

[MaterialX shader generation](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/DeveloperGuide/ShaderGeneration.md) separates typed input interfaces from their backend implementation. [PBRT's texture interface](https://pbr-book.org/4ed/Textures_and_Materials/Texture_Interface_and_Basic_Textures) treats constant and varying material inputs uniformly and avoids zero-weight texture sampling.

**Decision:** extend the existing paint operation with a typed partial palette record. Each role accepts a Color field; omitted roles retain style colors. The same original facet/pigment kernel consumes the result. Overridden fallback uniforms are omitted. A new color-ramp node takes a typed list of Color references and editable positions. [Culori's interpolation implementation](https://github.com/evercoder/culori/blob/main/src/interpolate/interpolate.js) and [Blender's ramp controls](https://docs.blender.org/manual/en/latest/interface/controls/templates/color_ramp.html) support separating stop placement, transition shape and color-space choice. The editor uses the same graph representation, including shared/varying stops.

The CPU selects one ramp interval and samples only its active color inputs. Identical references bypass irrelevant selectors; the GPU also preserves exact shared-color intervals. [OpenImageIO](https://openimageio.readthedocs.io/en/latest/texturesys.html) distinguishes sample footprints from output derivatives, so these differential rules remain separate from filtering claims. The shader keeps derivative-dependent upstream sampling outside varying selection branches.

## 28. Measure the representation, including its costs

The reproducible [16-stop comparison](history/0.52/color52.json) checks a compact ramp against an equivalent expanded mixture chain in both interpolation spaces. The compact form reduces graph nodes, uniform components and serialized bytes. Its generated GLSL text is larger. We retain both measurements and make no GPU-speed claim from source length. Independent law tests compare varying color inputs and their first differentials. Native probes cover the actual generated programs and compare the previous release's images separately.

## 29. A typed field must be a complete graph

The v52 signature already distinguished five result sorts, but its only graph
constructor demanded a Surface root. CPU sampling, serialization and typed
folds inherited that restriction. A standalone mask therefore required an
unrelated material wrapper. This was a boundary defect rather than a missing
noise preset.

[MaterialX's typed interfaces and target-specific implementations](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/DeveloperGuide/ShaderGeneration.md)
and [PBRT's texture evaluation contexts](https://pbr-book.org/4ed/Textures_and_Materials/Texture_Interface_and_Basic_Textures)
provide useful examples of separating field meaning from material use.
**Decision:** one `expressionGraph` validator accepts any result sort;
`materialGraph` is the strict renderer-facing specialization. Generic roots
serialize, patch and fold using the same v1 document. `createFieldSampler`
prepares supported field roots directly. CPU atlas and surface evaluation remain
an explicit unsupported capability rather than an invented dummy value.

## 30. Reuse needs explicit local and shared identities

Binding two copies of a named expression into different domains preserved the
same authored IDs, making their combined graph invalid. Automatically merging
the copies would also merge independently editable values.

[TSL supports ordinary JavaScript expression functions](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language#function),
while [MaterialX functional nodegraphs](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.Specification.md)
make reusable input interfaces explicit. **Decision:** retain ordinary
functions, and add deterministic `instantiate(expression,{prefix,shared})` for
an existing template. Local nodes are copied; declared shared inputs and their
descendants retain identity. Coordinate binding and instantiation now share one
bounded DAG rewrite. No serialized closure, group controller or duplicate
expression language is introduced.

Borrowed roots must already be constructor-owned immutable expressions. A raw shared object is rejected before copying; independently snapshotting it in two instances would break its promised shared identity, while caching it would hide future mutations. Raw local templates remain snapshot inputs.

## 31. Compose height before differentiating it

[Mikkelsen's surface-gradient framework](https://jcgt.org/published/0009/03/04/)
describes accumulating surface detail before resolving the final shading normal.
Moonweave already stored unresolved slope pairs for its facet paint, but generic
scalar fields could not contribute to them. **Decision:** add the single typed
operation `bump(Surface, Scalar)`. Its result inherits pigment and finish and
adds the scalar's first differential. A varying mask belongs inside the height
expression when its boundary should contribute to the result: the product rule
includes both mask and height derivatives. Existing `relief` keeps its distinct
meaning of multiplying an already-computed slope.

The GPU requests analytic scalar/domain differentials only for live height
ancestors. Noise shares one lattice evaluation between value and gradient.
This differs from resampling a finished height at several offset positions.
[OSL's derivative operators](https://open-shading-language.readthedocs.io/en/latest/stdlib.html#derivatives-and-area-operators)
make the context of differentials explicit; their separate filtering operations
also reinforce that derivatives alone are not an antialiasing implementation.

## 32. The application must expose the composition

The previous editor could change many values but required source editing to
connect a scalar to finish or create procedural detail. The new controls use
typed scalar connections, explicit additive detail nodes and existing finish
overrides. Color and scalar source choices share one cycle-safe query; graph
rewiring and orphan pruning reuse the existing immutable transaction boundary.
Examples apply one shared field to pigment, roughness and height. The UI does
not introduce a parallel recipe format.

## Evidence required of this release

The architectural claims need executable evidence: graph type and cycle rejection, deterministic normalization, literal algebra laws, stable structure and dependency invalidation for value edits, selective uniform derivation/writes, explicit sampling reuse, affine normal/differential rules, atomic material updates, reversible editing, session restoration, correct ownership, preserved atlas hashes, native shader compilation and actual composed renders. Browser limitations are recorded separately from native-driver results. See [VERIFICATION.md](VERIFICATION.md) and the linked release reports for the completed measurements.

## 33. Multiple interpretations should share one typed program

[Conal Elliott's Vertigo](https://conal.net/papers/Vertigo/) gives graphics,
textures and shading a functional semantics, and uses partial evaluation and
symbolic optimization to generate processor code.
[Compiling to categories](https://conal.net/papers/compiling-to-categories/)
shows typed programs receiving different interpretations, including automatic
differentiation and incremental computation. These are architectural precedents,
not claims that Moonweave implements those languages or their compiler theory.

**Decision:** keep the graph signature as the shared contract, interpret it for
CPU field sampling and compiler analysis, and generate demanded first
differentials in the renderer. Use one sharing-preserving expression rewrite
for coordinate substitution and instance ownership. Reusable authoring functions
remain JavaScript; no serialized function body, closure environment or parallel
node-group language is added. Real-number equations guide the design, while
compiler rewrites remain explicit about float32 ordering, editable parameters
and the limited semantics of artistic surface blending.

## 34. Persistence must lead back to composition

Reviewing the new standalone field boundary exposed one more gap: parsing a
field document gave a graph that could be sampled but could not be passed
directly into the expression constructors. Requiring consumers to reconstruct
typed nodes manually would make storage a break in the composition model.

**Decision:** add `graphExpression(graph, rootId?)`, a memoized interpretation
back into owned expression data using the existing reference mapper and DAG
fold. Preserve names and reachable sharing, with independent immutable
revisions. This is an authoring conversion, not another grammar operation or
serialized representation. Reification does not run compiler optimization.
It omits unused definitions from the returned expression while retaining them
in the original graph, making that document/program boundary explicit.

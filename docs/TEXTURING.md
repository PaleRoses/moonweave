# Surface integration and contracts

## 1. Author values, then bind resources

`@moonweave/surfaces/core` exports pure expression constructors, graph validation and compilation. It has no Three, DOM, GPU-resource owner, renderer or scene dependency. `@moonweave/surfaces/three` receives the host's required Three capabilities and creates material handles.

TypeScript users of the adapter also install `@types/three` matching their host Three revision. The atelier uses `three@0.187.0` and `@types/three@0.187.0`. Neither dependency is needed for the pure core entry point.

```ts
import {
  DataTexture, RGBAFormat, UnsignedByteType, RepeatWrapping,
  LinearFilter, LinearMipmapLinearFilter, NoColorSpace,
  FloatType, NearestFilter, ClampToEdgeWrapping,
  MeshPhysicalMaterial, Vector2, Vector3, Vector4, Matrix3, Matrix4,
  FrontSide, BackSide, DoubleSide,
} from 'three';
import {surface, scalar, facets, named, splitRecipe, materialGraph, patchGraph} from '@moonweave/surfaces/core';
import {createTexturingSystem} from '@moonweave/surfaces/three';
import type {TexturingEngine} from '@moonweave/surfaces/three';

const engine = {
  DataTexture, RGBAFormat, UnsignedByteType, RepeatWrapping,
  LinearFilter, LinearMipmapLinearFilter, NoColorSpace,
  FloatType, NearestFilter, ClampToEdgeWrapping,
  MeshPhysicalMaterial, Vector2, Vector3, Vector4, Matrix3, Matrix4,
  FrontSide, BackSide, DoubleSide,
} satisfies TexturingEngine;

const field = named('bodyField', facets(splitRecipe('carapace').mapping));
const body = named('bodyPaint', surface.paint(field, 'carapace'));
const belly = surface.paint(field, 'horn');
const transition = named('transition', scalar.ramp(scalar.facing([0, -1, 0]), -.25, .65));
const strength = named('strength', scalar.parameter(.9));
const graph = materialGraph(surface.mix(body, belly, scalar.multiply(transition, strength)));
const system = createTexturingSystem(engine);
const handle = system.createMaterial(graph);
mesh.material = handle.material;
```

| Capability type | Used by | Required capabilities |
| --- | --- | --- |
| `TexturingEngine` | `createTexturingSystem` | Paint texture capabilities below plus `FloatType`, `NearestFilter`, `ClampToEdgeWrapping`, physical material, vectors, matrices and side constants |
| `PaintTextureEngine` | `createPaintTextures` | `DataTexture`, format/type, wrapping and filter constants; optional color-space or legacy encoding constant |
| `CoordinateEngine` | `bindSurfaceCoordinates` | `BufferAttribute`, `Matrix3`, `Matrix4`, `Vector3` |

These are structural TypeScript types. Existing `createTexturingSystem(THREE)` callers remain valid. Explicit named inputs let a bundler see the adapter's dependencies. The example uses modern `NoColorSpace`; an r140 host can supply the optional `LinearEncoding` capability instead.

The first argument of `surface.paint(field, style)` establishes the coordinate mapping. A named preset in the second argument supplies its pigment and finish only. To use a preset's own scale, stretch, rotation and seed, use `surface.paint('horn')` or construct its own `facets(splitRecipe('horn').mapping)`.

## 2. Six types, explicit edges

| Type | Meaning | Operations |
| --- | --- | --- |
| Image | Shared immutable numeric float32 texels | `image.data`, `image.generate` |
| Scalar | A real-valued field over the current material context | `constant`, `parameter`, `axis`, `facing`, `noise`, `ramp`, `add`, `multiply`, `complement`, `image` |
| Domain | A transformed material context, including an optional pixel footprint | `domain.transform(matrix, parent?)` |
| Color | Extended linear Rec.709 RGB coordinates | `color.linear`, `color.srgb`, `color.oklab`, `color.oklch`, `color.mix`, `color.ramp`, `color.adjust`, `color.image` |
| Facet sample | Filtered pigment statistics and authored slopes | `facets(mapping)` |
| Surface | Linear RGB, screen-space slope pair and finish channels | `material`, `paint`, `mix`, `channels`, `relief`, `bump`, `coat`, `deposit` |

Constructors return immutable expression data. They can be nested or reused by reference. `expressionGraph(expression)` records any root sort as a versioned DAG; `materialGraph(expression)` adds the strict Surface requirement. Explicit JSON documents are also accepted. `parseExpressionGraph` imports arbitrary roots, while `parseGraph` remains surface-only. `createFieldSampler` prepares scalar, color or domain graphs directly, without an artificial material wrapper.

Our own normalized graph, style, mapping and constructor-expression identities are reusable values: repeated normalization returns the same value, and repeated compilation returns the same plan. Raw external objects are copied and validated. Freezing a caller object does not give it internal ownership. Reusing a trusted immutable value does not copy it or repeat boundary validation.

```js
const strength = scalar.parameter(.7);
const transition = scalar.ramp(scalar.axis('y'), -.4, .6);
const mask = scalar.multiply(strength, transition);
const result = surface.channels(
  surface.mix(surface.paint('horn'), surface.paint('obsidian'), mask),
  {roughness: scalar.add(.25, scalar.multiply(.6, transition))},
);
```

The four finish overrides are `roughness`, `metalness`, `clearcoat` and `opacity`. Their final values are clamped to `[0,1]`. Relief scales authored slopes; it does not displace geometry.

`surface.bump(input, height)` adds the scalar height's analytic first
differential to the existing slope pair. Its amplitude and masks use ordinary
scalar composition: `D(mask * height)` includes both `mask * Dheight` and
`height * Dmask`. The shader computes first differentials only along live height
paths. A demanded noise value and gradient share their eight lattice corners.
The final normal is resolved once after slope composition. Bump does not modify
vertices, silhouettes or shadow geometry, and derivatives alone do not filter
high-frequency fields. An image reader can explicitly filter its value and
partials using the pixel footprint; procedural noise remains point sampled.

Borrowed `shared` roots must be Moonweave-owned immutable expressions. Constructors, `named`, `instantiate` and `graphExpression` produce owned values. Merely freezing a raw object or passing it through an identity `inDomain(raw)` call does not establish ownership. Construct a raw shared value once before inserting it in the template; mutable raw objects cannot provide stable shared ownership. Raw local templates remain valid snapshot inputs.

`instantiate(expression, {prefix, shared})` makes independent local copies of a
named template, preserves sharing within each copy, and borrows explicitly
shared input subgraphs. It prefixes authored IDs without adding a serialized
module node. Use `inDomain` separately for placement.

The full grammar, denotational contracts, derivative rules and reusable function examples are in [GRAMMAR.md](GRAMMAR.md).

These types are derived from `SURFACE_SIGNATURE`, the operation table in `src/core/algebra.mts`. A kind declares its result sort, typed ports, literal data and editable data once. The validator, reference mapper, value editor and compiler consume that signature. `GraphNodeOf<'paint'>`, `GraphSort`, `NodeKind`, `ResolvedNode` and `Algebra` are exported TypeScript types.

### Related colors and finite coverage

`color.adjust(input, {lightness, chroma, hue})` applies an Oklab lightness offset,
chroma multiplier and hue rotation in degrees. All three are Scalar ports with
constructor defaults `0`, `1`, `0`. Use parameters for editable controls or
fields for spatial relationships. The operation preserves extended linear RGB;
it does not apply display encoding or gamut mapping. `color.oklab` and
`color.oklch` are literal authoring conversions, not additional graph kinds.

`mask.interval(input, low, high, {feather})` composes inward smooth ramps;
`mask.chisel({domain, feather})` multiplies three local `[-1,1]` interval masks.
The interval defaults to 10% inward feather; chisel defaults to `.2` local units
per axis. Both return ordinary Scalar expressions. Use a domain to place marks,
a Color mix to apply pigment, a finish channel to alter reflectance response,
and a height expression for relief. Those choices are independent. The full
bounds, derivatives and sampling limits are in [GRAMMAR.md](GRAMMAR.md).

### Name the controls a composition exposes

`named(id, expression)` preserves the expression's sort and supplies its graph ID. It is an authoring operation, not another graph node. A reusable function can expose deliberate controls without requiring its consumer to inspect generated IDs:

```js
function shell(prefix) {
  const field = named(`${prefix}-field`, facets(splitRecipe('carapace').mapping));
  const paint = named(`${prefix}-paint`, surface.paint(field, 'carapace'));
  const relief = named(`${prefix}-relief`, scalar.parameter(.8));
  return surface.relief(paint, relief);
}

const graph = materialGraph(surface.mix(shell('back'), shell('belly'), .35));
const next = patchGraph(graph, {
  'back-relief': {value: .6},
  'belly-paint': {style: {roughness: .8}},
});
```

IDs are 1–64 characters, begin with a letter or underscore, and contain only letters, digits, underscores or hyphens. They are unique across one graph. Reusing the same returned expression shares one node. Two distinct expressions with the same ID are rejected, even if their current values match; use a different prefix for independent instances.

Generated IDs skip all authored IDs, including names encountered later in traversal. Entirely unnamed expressions retain their existing deterministic serialization. Names survive serialization, `patchGraph` and `inDomain`; they do not alter the canonical shader program. Independently placed copies of a named composition need distinct names if they will coexist in one graph. Naming a constant leaves it a constant; use `scalar.parameter` for an editable value. Renaming returns a new expression and never mutates the original.

### Return a stored field to composition

`graphExpression(graph, rootId?)` returns an owned expression for the graph's
output or a selected node. It preserves authored IDs and reachable DAG sharing,
so the result can be passed to `inDomain`, `instantiate` and the regular surface
constructors. The same immutable graph/root reuses its expression; a patched
revision has its own expression. There is no cache of mutable raw documents.

Only nodes reachable from the selected root become expression data. Unused
imported definitions remain in the original graph, but are omitted if the
returned expression is converted back with `expressionGraph`. This conversion
reifies the authored graph, without applying compiler optimization. A parsed
graph has an unknown root sort until inspected; check the returned expression's
kind before applying a constructor that requires a particular sort.

### Interpret the same graph

`foldGraph(graph, algebra)` interprets the graph's root, of any sort. `foldGraph(graph, algebra, rootId)` instead starts at a named node. Each reachable node is visited once, so shared references become shared interpreted values. Unused nodes are validated on import but are not evaluated by the fold. A missing handler produces an explicit error.

For example, this small interpretation reports the fields referenced by a composition with a parameter mask:

```js
import {foldGraph, facets, surface, scalar, materialGraph}
  from '@moonweave/surfaces/core';

const sample = facets();
const graph = materialGraph(surface.mix(
  surface.paint(sample, 'carapace'),
  surface.paint(sample, 'horn'),
  scalar.parameter(.7),
));
const fieldIds = foldGraph(graph, {
  facets: node => new Set([node.id]),
  color: node => node.value,
  paint: node => node.field,
  parameter: node => node.value,
  mix: node => new Set([...node.a, ...node.b]),
});
console.log(fieldIds.size); // 1
```

This interpretation intentionally covers only the kinds in that graph. A general backend supplies a typed `Algebra` covering its input sorts. `Algebra<R>` replaces reference ports with values from the result type assigned to their sort; a scalar input cannot accidentally become a raw reference string. The fold provides traversal and sharing, while handlers provide meaning. It does not imply that Moonweave already implements a CPU paint sampler or a second GPU backend.

## 3. Constants and parameters have different contracts

`scalar.constant(0)` is a compile-time fact. `scalar.parameter(0)` is an editable value. Numeric shorthand passed into arithmetic or surface operators is a literal constant.

These identities are used to remove work:

```
x + 0 = x
x × 1 = x
x × 0 = 0
mix(A, B, 0) = A
mix(A, B, 1) = B
mix(A, A, m) = A
relief(A, 1) = A
```

`A` means the same referenced expression, not two independently editable paints that happen to have equal initial values. A mask parameter currently equal to zero keeps its two branches. Moving it to one therefore updates uniforms without creating a new shader. Changing a literal can change the compiled structure.

The compiler does not assume floating-point addition or arbitrary nested mixtures are associative. It retains nested complements because cancellation can make `1 − (1 − x)` differ from `x` for tiny values. It does not merge separately authored parameters, samples or paints by their numeric values. Reference-based common subexpressions can share work safely.

## 4. Compilation

`compileGraph(input)` returns:

- `graph`: the validated authoring document, including valid unused nodes.
- `nodes` and `output`: a canonical, reachable execution plan after specialization and reference-based reuse.
- `programKey`: the complete structural signature. It includes literal constants and excludes editable numeric data.
- `structure`: the shared compiled artifact across value revisions: output, key, bindings, diagnostics and cost.
- `bindings`: `{sourceId, nodeId, index}` records mapping editable source nodes to canonical execution slots.
- `ranges` and `opacityRange`: conservative scalar/opacity bounds used by the adapter.
- `cost`: live facet samples (`paintSamples`), procedural evaluations (`proceduralSamples`), texture-read ceilings (`textureReads`) and numeric uniform components (`uniformScalars`, including uint seeds).
- `diagnostics`: explanations of eliminated or shared work.

Each live facet sample performs three triplanar lookups plus one broad wash lookup. Sharing that sample between two paints still costs four reads. Adding an independent sample costs another four. The displayed uniform count includes Moonweave's atlas-resolution float only when at least one live facet sample uses it and excludes sampler handles and the host engine's lighting/camera uniforms. It is not a hardware register count or a frame-time prediction.

Image readers share reconstruction by image, domain, address and filter. Each
shared sample contributes a texture-read ceiling of 4 for `linear`, 8 for
`trilinear`, or 64 for `anisotropic`. A filtered reader can perform fewer reads
according to its footprint and mip blend. The atelier labels filtered totals
as ceilings. Shared R/G/B readers do not each incur a separate reconstruction.

The renderer checks its supported budget before allocating a material: at most eight facet fields, sixteen paint styles and sixteen noise fields. The document validator bounds node count, depth and imported JSON size. Device-specific scene costs still depend on lighting, geometry, overdraw and the renderer.

Lowering, specialization, canonical naming, program-key construction and cost calculation happen once per topology. A value revision reuses those results and binds its current values. Analysis keeps one latest entry per canonical node, keyed by the relevant value input and its child-result identities. Unchanged scalar intervals, composed domains and opacity bounds are reused. A changed ancestor transform or scalar input still invalidates dependent results, even when the descendant node object is unchanged.

Each revision still walks the canonical nodes to check those dependencies. The cache is bounded by the retained node count and stores no previous-plan chain. The atelier's explicit undo history is a separate consumer of immutable graph values.

## 5. Updating a live material

Graphs are immutable. Patch values directly at the material boundary:

```js
handle.patch({
  strength: {value: .4},
  transition: {low: -.4, high: .6},
  bodyField: {scale: .2},
  bodyPaint: {style: {roughness: .7}},
  bodyPigment: {value: color.srgb('#617c89').value},
});
```

The target IDs must exist in the authored graph. Use `named` at construction or supply IDs in an explicit document; unnamed expressions receive deterministic IDs. The pure counterpart is `patchGraph(graph, changes)`, followed by `handle.setGraph(next)` when desired.

| Node | Editable value patch |
| --- | --- |
| `parameter` | `value` |
| `noise` | Unsigned 32-bit integer `seed` |
| `color` | `value`: three finite extended linear RGB components, each within `±1e20` |
| `colorRamp` | `positions`: unchanged stop count, strictly increasing float32-representable gaps of at least `1e-6` |
| `facing` | `direction` |
| `ramp` | `low`, `high` |
| `transform` | `matrix` |
| `facets` | `scale`, `stretch`, `rotation`, `seed` |
| `paint` | Numeric `style` fields; color values belong to referenced `color` nodes |

Value patches validate edited data, copy the node array once, and preserve all unchanged node objects. Paint patches validate only supplied numeric style fields and borrow the unchanged palette reference record. A color patch updates the referenced color node, so every explicit user observes the edit. An empty or equivalent patch returns the original graph. Separate paint nodes can share an immutable style while remaining independently editable. Source and compiled nodes stay aligned by binding metadata; edits to unused definitions cause no uniform writes.

`NodeValuePatch` is derived from the signature's editable value types. Paint retains a numeric `StylePatch`; a pigment edit uses the ordinary Color value patch. References, axis selection and facing mode are excluded from the patch type. Runtime validation also checks whether the addressed node is editable: a `{value: .5}` patch can target a parameter but cannot target a constant.

Node kinds, references, literal constants, axis selection, color interpolation choices and the facing `absolute` option define structure. Make those edits through a new document and `materialGraph`/`setGraph`. They can change optimization and shader code. A literal mask never becomes a parameter merely because a control changed it.

Value analysis, opacity checks and changed binding preparation complete before live state changes. Numeric edits preserve the material, compiled structure and shader key. Structural edits preserve the material object and request the appropriate shader program. The adapter retains typed uniform containers across program revisits, including A → B → A transitions. Passing an identical graph is a no-op.

Within a shared compiled structure, only changed uniform groups are derived and written:

| Authored values | Binding group |
| --- | --- |
| `contrast`, `wash`, `marks`, `quiet` | Pigment `vec4` |
| `roughness`, `roughnessVariation`, `metalness`, `clearcoat` | Finish `vec4` |
| `relief`, `opacity` | Response `vec2` |
| Field `scale` | One float |
| Field `stretch` | One `vec3` |
| Field `rotation` | Derived direction `vec2` |
| Field `seed` | Derived offset `vec3` |
| Noise seed | One uint |
| Color value | One extended linear-RGB `vec3` |
| Color ramp | One float per stop position; shared Color references provide the colors |
| Parameter value, facing direction, ramp edges | Float, `vec3`, `vec2`, respectively |
| Domain matrix | `mat4` and derived inverse-transpose `mat3` |

A roughness-only edit writes one finish vector without decoding colors. A scale-only edit writes one float without recomputing rotation or seed offsets. Shader creation and topology replacement still prepare the full required layout; selective updates do not remove its bindings.

For the single-recipe convenience entry, this remains available:

```js
const horn = system.createMaterial('horn');
horn.update({style: {roughness: .7}, palette: {base: color.srgb('#c8ba9e')}});
```

Graph-authored handles use `patch` for values and `setGraph` for replacement. Their `recipe` is `null`. Calling `update('horn')` explicitly returns to a single recipe. Three's `Material.clone()` does not preserve these shader hooks, so create a new handle from `handle.graph`.

## 6. Coordinate algebra

A domain matrix is a column-major affine 4×4 transform. Let its linear part be `A` and translation be `b`. It maps:

```
p′ = A p + b
∂x p′ = A ∂x p
∂y p′ = A ∂y p
n′ = normalize(A⁻ᵀ n)
```

`domain.transform(B, domain.transform(A))` evaluates `B(A(p))`. Matrix order is observable. Normals use the inverse transpose; position differentials do not. Normal differentials pass through normalization with its derivative.

### Bind a complete composition

`inDomain(expression, frame?)` substitutes a frame for every implicit rest-domain input in an expression. Paint fields, positional masks and facing masks move together. Existing transform chains retain their order and shared children retain their sharing. The return type preserves the expression's sort.

```js
import {domain, inDomain, materialGraph} from '@moonweave/surfaces/core';

const frame = domain.transform([
  1.4, 0, 0, 0,
  0, 0.8, 0, 0,
  0, 0, 1, 0,
  0.2, -0.1, 0, 1,
]);
const placed = materialGraph(inDomain(surfaceExpression, frame));
```

Omitting the frame returns the original expression by identity. Coordinate-free constants and parameters remain shared. Ordered substitution obeys

```js
inDomain(inDomain(expression, a), b)
// same ordered graph as:
inDomain(expression, inDomain(a, b))
```

This binds `b` beneath `a`; it does not exchange the transforms. The implementation retains both matrix operations rather than replacing them with a pre-multiplied matrix. That preserves authored evaluation order and avoids claiming an unsafe floating-point associativity law.

`evaluateScalar(graph, id, context)` returns `{value, dx, dy}` for scalar expressions. `evaluateColor` returns the same shape with a linear RGB triple for each member; color mixing propagates the mask derivative using the product rule. The context accepts position, normal, two position differentials, optional normal differentials and an optional pixel footprint. `evaluateDomain` exposes the transformed context. Evaluation owns one incremental preparation per immutable graph. All requested roots share its prepared nodes, scalar structural representatives, image readers and transform inverses. Each sample receives a fresh normalized context and memo; multi-output sampling shares that context/memo across its selected roots. Changing or reusing a mutable caller context cannot reuse stale sample results. Patched graphs own new preparations. There is no module-global inverse-matrix preparation cache. First sampling does more preparation than repeated sampling, and the benchmark reports both. These are independent CPU semantic checks and useful tools for inspecting masks. They do not evaluate atlas pigment, perform lighting, or reproduce framebuffer colors.

`context.footprint: PixelFootprint` contains independent `dx` and `dy` Vec3
displacements across one pixel in the rest frame. Image filters use these
vectors to choose their reconstruction. The context's top-level `dx` and `dy`
remain arbitrary calculus directions; changing them alone cannot change a
filtered value. A domain applies its linear transform to each footprint vector.
An omitted footprint asks for point reconstruction. Filtered image partials
hold the footprint, LOD and tap configuration fixed, differentiating position
within that reconstruction rather than differentiating the filter choice.

The GPU derives texture footprints before any mask composition. Derivative-based filtering and authored facet slopes remain distinct data. Tiny features cannot simply borrow the visibility weight of another projection.

## 7. One rest frame across parts

Local coordinates attach paint to each mesh's undeformed positions. Attribute coordinates let multiple meshes share one creature frame:

```ts
import {BufferAttribute, Matrix3, Matrix4, Vector3} from 'three';
import {bindSurfaceCoordinates} from '@moonweave/surfaces/three';
import type {CoordinateEngine} from '@moonweave/surfaces/three';

const coordinates = {BufferAttribute, Matrix3, Matrix4, Vector3} satisfies CoordinateEngine;

creature.updateWorldMatrix(true, true);
const inverseRoot = creature.matrixWorld.clone().invert();
const handle = system.createMaterial(graph, {coordinates: 'attribute'});

creature.traverse(object => {
  if (!object.isMesh) return;
  const toRoot = inverseRoot.clone().multiply(object.matrixWorld);
  bindSurfaceCoordinates(coordinates, object.geometry, {matrix: toRoot});
  object.material = handle.material;
});
```

`bindSurfaceCoordinates` writes `aMoonweavePosition` and `aMoonweaveNormal` only after both arrays validate. Shared geometry instances that require different rest frames need distinct geometry objects before binding. Geometry, animation and lights remain owned by the host. Morphing and skinning operate after the stored rest coordinates are captured by the vertex shader.

## 8. Ownership

One system lazily owns one atlas pair and its created material handles. A material with no live facet sample allocates no atlas textures and emits no atlas sampler or facet kernel. Introducing a facet acquires the pair at that commit; later program revisits reuse its bindings. A failed acquisition leaves the current material intact. Disposing a handle releases its material once. Disposing the system releases remaining materials and its owned pair, while attempting all cleanup even when a listener throws.

To share fields across several systems, create a separate owner:

```js
import {createPaintTextures, createTexturingSystem} from '@moonweave/surfaces/three';

const fields = createPaintTextures(engine, {resolution: 512});
const a = createTexturingSystem(engine, {fields});
const b = createTexturingSystem(engine, {fields});
// Both systems borrow. Neither disposes fields.
a.dispose(); b.dispose(); fields.dispose();
```

Do not dispose the atlas owner while materials still borrow it. Supplied atlas bytes are also borrowed and must remain immutable. The standard 512² pair occupies 2,796,200 bytes including mip levels, independent of the number of paint styles.

## 9. Serialization

```js
import {serializeGraph, parseGraph} from '@moonweave/surfaces/core';
const json = serializeGraph(handle.graph);
const restored = parseGraph(json);
```

The document is `{version:2, nodes:[...], output:'nodeId'}`. Nodes have explicit `id` and `kind`. References are IDs. Sample nodes contain mapping values; paint nodes reference a sample and all three Color palette inputs, and contain numeric style values. Version-1 documents migrate at import. Unknown properties, wrong connection types, duplicate IDs, dangling references, cycles, invalid transforms, invalid float values and excessive graphs are rejected. Importing data never evaluates JavaScript.

The atelier accepts old version-43 recipe objects as well as graph documents. Paint and blend selection operate on actual node IDs. Adding a paint wraps the previous output in a new blend; changing values preserves the preceding graph. A field picker and “Make independent” action expose sample sharing directly. Paint controls use canonical style and mapping values; a legacy combined recipe is no longer reconstructed for each view. Mask and general surface controls retain distinct parameters and explicit literals. Color, noise seed, scalar and affine-domain controls are also exposed. Materials without paint can be edited, saved and extended with paint. Color ramps expose stop positions, linear/Oklab space, linear/smooth/step interpolation, color connections and reversible Add/Remove. Literal stop colors are edited beside their stops. Every paint pigment connects to a Color field. Making a pigment independent creates a literal from the field at the rest origin; no style-color fallback exists. Applying a paint preset restores its palette and removes newly orphaned procedural work while preserving shared users. Color adjustments expose their source plus lightness, chroma and hue controls, with optional Scalar connections. Adding an adjustment wraps the connected uses while preserving its source ID; removal bypasses it and prunes only unused definitions. Palette and value controls appear first; Field construction groups ramp, facing, noise and domain controls in a disclosure. General rewiring remains available in the source editor.

### Editor history and local sessions

Each literal palette connection exposes extended linear RGB values directly in
Paint, using the same numeric controls as color-ramp stops. Editing a shared
literal updates its connected uses. A varying field instead offers **Sample at
rest origin**, which creates a constant at that position; it does not copy the
field's spatial variation.

The accepted graph, reset baseline, selection and unapplied source draft belong to the editor. History stores up to 100 transactions with before/after graph and baseline references plus selected node IDs; it does not clone or serialize graph contents. A gesture accumulates accepted value patches against its starting graph, with later values replacing earlier values at the same field. Rejected previews do not change that accumulated patch. Returning exactly to the starting values restores the starting graph identity, records no transaction and preserves Redo. A changed gesture becomes one undo transaction when it ends; Undo and Redo pass through the same commit checks as other edits and preserve an unapplied source draft.

The local session stores the current graph, baseline, selections, active tab and source-panel state. Session format 2 writes the full baseline once; the current graph contains its changed nodes and references unchanged baseline nodes by ID. Restoring those references preserves immutable node and image ownership, so saving again does not expand the document. Separately authored equal resources remain independent. Format-1 sessions remain readable and migrate on the next save. Saving is debounced by 400 ms and flushed at lifecycle checkpoints. Restored graphs are validated before use. The source draft is saved separately from the accepted graph; the undo/redo stack and GPU objects are not saved. Session storage is separate from exported graph JSON, whose normalized format is version 2. Storage errors leave the live document available and report an unavailable save status.

The four distributed ESM entry points import shared modules from `chunks/`. Keep the full module directory together when copying it directly. Package consumers and bundlers resolve this automatically; authoring and rendering entries then share the same immutable identities and compiled structures.

## 10. Rendering scope

Revision 53 retains the filled-facet style and Three `WebGLRenderer` backend, and adds scalar-height detail with demanded analytic differentials. The supported renderer context is WebGL2; integer noise hashing requires GLSL ES3, including with Three r140. Compatibility is checked at the pinned r140 and r187 endpoints; shader-anchor checks fail clearly when an engine changes an expected chunk. This is not a guarantee for every intervening or future renderer release.

The host's physical material handles lighting, shadows, fog and tone mapping. Palette inputs are Color expressions. `color.srgb` decodes sRGB literals before interpolation; tagged colors use the explicit `toWorkingColor` import boundary. `color.linear` and serialized color values are extended linear Rec.709 RGB coordinates. Oklab interpolation preserves out-of-gamut intermediates. Generic material inputs and explicit paint-palette inputs clamp to `[0,1]` at the reflectance boundary; the original pigment kernel keeps its existing grain gain. Reflectance projection is channel clipping. The separate `displayColor` boundary performs CSS Color 4 perceptual gamut mapping for sRGB or Display P3; converting coordinates with `convertColor` preserves extended values. Select a mapped reflectance explicitly before authoring a mark. See [COLOR.md](COLOR.md). Atlas channels are non-color scalar data. Opacity below one requires the structural `{transparent:true}` option, which disables depth writing; ordinary transparent-surface sorting remains the host renderer's behavior.

Surface mixing interpolates material parameters and slopes. It does not compute physical coating layers, a mixture of complete BRDFs, displacement, diffusion, refraction, film interference or UV baking. The JSON graph is Moonweave's own format, not a MaterialX or glTF extension. Those features need separate backends or operators with explicit semantics.

The source layout and research rationale are in `docs/RESEARCH.md` in the source archive. Exact checks and measurements for this release are in `docs/VERIFICATION.md` in the source archive.

## Procedural resources, filtering and zone applications

The LLM-first authoring walkthrough is [APPLICATIONS.md](APPLICATIONS.md).
`image.data` owns supplied numeric texels; `image.generate` materializes a
callback once. Image expressions serialize as shared resource nodes.
`scalar.image` and `color.image` read `domain.position.xy`, with structural
`address: 'clamp' | 'repeat' | 'zero'` and
`filter: 'linear' | 'trilinear' | 'anisotropic'`. Omitted filtering and explicit
`linear` preserve the canonical base-level bilinear path. There is no hidden
image decoding, asset resolver or network dependency.

Derived mips average overlapping source texel cells, including odd dimensions,
and are shared by immutable image identity. Trilinear reconstruction chooses
adjacent levels from the major footprint extent. Bounded anisotropic
reconstruction takes up to eight trilinear taps along the principal major axis
and widens the minor filter if the anisotropy exceeds eight. Zero addressing
extends finite images with zero values; virtual coarse levels preserve their
integrated mass while diluting marks smaller than a pixel. Clamp and repeat
retain their respective edge and periodic behavior. Values and analytic
partials follow the same explicit reconstruction. See
[FILTERING.md](FILTERING.md) for the complete numerical contract and limits.

`zone(name, mask, {color, channels, height})` labels an application and snapshots its complete mask/effects record once. Raw shared roots and descendants remain shared across all properties. Only `named()` assigns node IDs. `applyZones(base, zones)` composes them in order. Pigment uses `surface.coat`; finish uses partial channel targets; height adds the full product differential. The `coverage` helpers are bounded soft operations rather than Boolean sets. The `pigment` namespace retains additive spectral quantities during authoring and can bake them into resource palettes.

Resource patches replace the complete descriptor, including shape when needed, without changing program structure. They replace the derived mip pyramid with the image data. The Three owner shares image textures by normalized resource identity across handles, releases replaced resources, and clears stale sampler slots. Domain and filter edits can reuse the same storage, while filter and address changes are structural graph edits. A failure from a consumer's texture-disposal listener is reported after all releases are attempted; a graph replacement has already committed its new plan when such a cleanup failure is reported. This keeps the handle's graph, uniforms and ownership coherent.

The adapter supports six embedded images in addition to its optional atlas
pair. It uploads a complete float32 mip pyramid with nearest storage and uses
explicit texel reads, so float-linear filtering and driver anisotropy
extensions are unnecessary. This is a defined filtering approximation, not an
exact pixel integral. General expression products are not automatically
prefiltered: `F(a*b)` and `F(a)*F(b)` differ, so correlated deposition or finish
decisions should be baked into packed channels when required. Mesh UV
attributes, external asset resolution and geometry displacement remain
separate capabilities.


## Canonical recipes and import migration

Graph v2 requires `paint.palette = {base, shadow, light}` with three Color-node
references. A recipe contains `{version:2, mapping, style, palette}`; its palette
contains Color expressions. Missing author overrides are filled once from the
chosen preset. The numeric style and renderer contain no legacy sRGB swatches.

`parseGraph` / `expressionGraph` import v1 graph documents through a single
migration before normalization. Existing explicit field connections retain their
IDs, absent roles become decoded linear Color nodes, and formerly independent
swatches remain independently editable. Generated IDs cannot collide with source
IDs. `migrateSurfaceRecipe(oldFlatRecipe)` provides the corresponding explicit
recipe boundary. The atelier's file/source import applies it automatically.

For a recipe-owned material, literal palette edits retain compiled topology when
aliases allow it. A structural color-field edit rebuilds the graph while preserving
its field and paint IDs. Changing one role of a shared literal does not silently
recolor its siblings. Graph-authored clients explicitly patch or replace the graph.

Preset palettes are shared owned expressions. Two `surface.paint('horn')` calls
can reference the same preset color nodes while retaining independent paint
nodes and numeric styles. A graph patch to a shared color updates all its users.
To give one role an independent control, copy its expression explicitly:

```js
const hornRecipe = normalizeSurfaceRecipe('horn');
const bodyBase = named('bodyBase', instantiate(hornRecipe.palette.base, {prefix: 'body'}));
const body = surface.paint(hornRecipe, {palette: {base: bodyBase}});
```

`instantiate` copies the complete color field and its local controls. The
atelier's independent-pigment action creates a new literal from the connected
field at the rest origin. Unchanged roles continue to share their original
expressions; v1 imports preserve independent legacy swatches as separate nodes.

## Several fields, one sample

```js
const sample = createFieldSampler(graph, {
  height: {id: 'detail', sort: 'scalar'},
  pigment: {id: 'bodyPigment', sort: 'color'},
});
const {height, pigment} = sample({position: [0, .4, 0]});
```

The output keys and sample types follow the request record. Root IDs/sorts validate
when the sampler is prepared; one normalized context and memo serve each call.
This shares overlapping work across roots without retaining sampled values between
calls. Single-root convenience APIs use the same graph-owned preparation.

## Ordered marks

[MARKS.md](MARKS.md) defines the serializable dab/stroke program, brush masks,
affine placements, finite zones, pressure, spacing and indexed rasterization.
`bakeMarks` integrates associated pigment and its coverage, independent finish
contributions, and additive covered height together. `applyMarkBake` turns the
result into ordinary image readers, one `surface.deposit` and an optional bump.
It has no runtime dab loop and requires no separate renderer or manual painting.
Expanded dabs and tile bins are discarded after authoring.

For each associated channel, deposition observes `p + (1-a)*prior`; absent finish
channels preserve their prior values. Filtering therefore retains the product
`coverage * pigment` rather than multiplying unrelated filtered averages. The
height channel is already covered and feeds bump without a second mask factor.

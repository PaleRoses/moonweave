# A typed graph with shared execution

Moonweave 0.60 has one canonical graph, one ownership boundary and one incremental
CPU preparation per immutable graph. A field can be sampled alone or as one
member of an explicitly selected output record. The authored document retains
its controls; eligible execution work shares without merging independently
editable values.

Public function declarations are generated from their implementation sources.
Expression/node unions derive from `SURFACE_SIGNATURE`; graph/plan data contracts
live in `core/types.mts`; field, zone, resource, color and mark interfaces live
beside their functions. Type-only export barrels collect these contracts without
restating signatures. `.mts` sources execute on Node 24 through type stripping;
esbuild produces the distribution JavaScript. Generated declaration imports
resolve to `.mjs` modules, and the build retains only their public dependency
closure. Installed-package consumers check the renderer-free core without DOM
or Three types. Internal shader generators, atlas kernels and spectral tables
still include JavaScript modules.

## One language, three views

| View | Purpose | Identity |
| --- | --- | --- |
| Authored graph-v2 document | Composition, named controls, resource ownership, serialization | Stable authored node IDs |
| Compiled execution DAG | Literal specialization, structural sharing, dead-work pruning, resource costs | Dense topological slots with `n0`, `n1`, … identifiers |
| Inspection projection | Explain actual execution to an LLM or display it in the atelier | Integer edge endpoints and authored-to-compiled provenance |

These views interpret the same six-sort signature. `SURFACE_SIGNATURE` supplies
operation sorts, ordered input ports, structural literals and editable payloads.
Graph types, validation, traversal and the structural sharing key derive from
that information. Graph-v1 imports migrate once into graph v2. Every paint then
has three color-reference inputs; numeric paint styles contain no second
palette representation.

The execution DAG contains one result for each eligible repeated expression.
Several ports may reference that result. Arithmetic operand order and grouping
remain authored structure. Current parameter values never become structural
constants.

## One construction boundary

`core/ownership.mts` owns a weak proof of immutable construction. `ownValue`
snapshots an entire authoring value with one local object map, preserving repeated
roots and shared descendants. It freezes and owns every copied record and array.
Already-owned expressions, normalized recipes and image resources are borrowed.
Merely freezing caller data never supplies this proof.

Expression constructors, palette normalization and zones use that same
mechanism. No helper has a second partial clone or mutable-caller cache.
`zone(name, mask, effects)` snapshots coverage and all effects together. Reusing
one raw editable expression for coverage, roughness and height produces one
control, and sharing a descendant between different raw roots is preserved too.
Equal but distinct raw objects remain independent.

A zone name labels an application. `named(id, expression)` alone assigns a node
ID; zone construction does not rename or split a shared coverage root. Separate
zone calls are separate snapshots, so use one owned expression when several
applications should share an editable control.

Canonical recipes contain independent mapping, numeric style and expression
palette records. A partial edit reuses unaffected records and owned color roots.
Complete owned palettes are borrowed directly. `patchGraph` validates only the
signature's editable payloads against the complete current node. Immutable ports
and literals remain untouched: a paint-style edit retains its palette-reference
record, and a ramp-position edit retains its color-reference list while checking
that the positions still match the stop count.

Preset palettes are owned immutable expressions and are deliberately borrowed.
Two paints using the same preset can therefore share its color nodes while their
paint nodes and numeric styles remain independently editable. Patching a shared
color node affects every reference to it. For an independent role, copy that
color expression explicitly and give its control a name:

```ts
import {normalizeSurfaceRecipe, instantiate, named, surface}
  from '@moonweave/surfaces/core';

const horn = normalizeSurfaceRecipe('horn');
const bodyBase = named('bodyBase', instantiate(horn.palette.base, {prefix: 'body'}));
const body = surface.paint(horn, {palette: {base: bodyBase}});
// bodyBase is independent; the untouched shadow/light roles still borrow horn.
```

`instantiate` copies the complete color field and its local controls, including
procedural descendants. The atelier's independent-pigment action creates a new
literal color from the connected field at the rest origin. Version-1 import
keeps formerly independent swatches independent by creating separate color nodes.

## What may share

`core/intern.mts` defines the structural key used by compiler lowering, CPU scalar
preparation and optimizer reconstruction. It includes operation kind, ordered
port identities and structural literals, and omits the authored ID. The complete
ordered encoding is the equality key; no short hash can collide and merge
unrelated expressions.

Operations with editable payloads have no structural key. Distinct parameters,
colors, images, noise seeds, transforms, ramp stops and paint styles keep their
own identities even when their current data is equal. Referencing one owned
expression intentionally shares it; constructing two editable expressions
preserves two controls.

Compiler interning belongs to one compilation. CPU scalar interning belongs to
one graph's incremental preparation, so a later root request can reuse an earlier
root's representatives. No structural pool retains every graph or edit revision.

```ts
import {color, scalar, surface, named, materialGraph, createFieldSampler}
  from '@moonweave/surfaces/core';

const gain = named('gain', scalar.parameter(.7));
const left = named('leftHeight', scalar.multiply(scalar.axis('y'), gain));
const right = named('rightHeight', scalar.multiply(scalar.axis('y'), gain));
const graph = materialGraph(surface.channels(
  surface.material(color.linear([.15, .38, .55])),
  {roughness: scalar.add(left, right)},
));

const sample = createFieldSampler(graph, {
  left: {id: 'leftHeight', sort: 'scalar'},
  right: {id: 'rightHeight', sort: 'scalar'},
});
const result = sample({position: [0, .5, 0], dy: [0, 1, 0]});
// result.left and result.right are typed scalar samples.
// Both share the prepared axis/product and the same result within this call.
```

The authored graph remains intact. `patchGraph(graph, {gain: {value: .82}})` edits
the shared control while retaining compiled topology. Two distinct named
parameters with equal values remain separate after the same kind of edit.

## Preparation and sampling have different lifetimes

A graph owns one incremental preparer containing prepared point functions by
source slot, scalar representatives, their structural keys and cached single-root
samplers. Preparing another root visits only new reachable slots. It does not
prepare unrelated material or field branches. A value-patched graph owns a new
preparer; it never reuses closures that read the previous revision.

The preparer's field algebra owns literal-specialization metadata and shared
image reconstruction functions. Transform inverses are computed while preparing
the transform point, with no second inverse-matrix cache. Image reconstruction
keys use prepared resource/frame identity, address mode and filter; typed scalar
and color readers project that shared reconstruction.

Every sampling call creates one normalized context and one result memo. The
single-root API retains its original boundary. The output-record overload uses
one boundary for all selected outputs, so shared dependencies compute once for
the whole record. Output selection is copied into the prepared function; caller
records can change without changing that function. The returned record and
samples are immutable. Contexts and result memos are discarded after the call.

`FieldOutputs<R>` maps each selected name to its declared sort: scalar samples
have numeric `value`, `dx` and `dy`; color samples have three-component values and
tangents; domain samples have positions, normals and their supported
differentials. Root sorts are also checked at preparation. Sampling several
outputs never requires a union-typed result at every property.

### Exact observable behavior

CPU structural interning shares pure scalar operations, including scalar image
projections and arithmetic. It preserves authored color-point identities. Those
identities control color-mix and ramp shortcuts: merging two independently
authored colors could remove an Oklab conversion, change low bits or hide an
invalid scalar mask that previously evaluated. Scalar inputs inside color
expressions can still share.

Preparation does not reassociate arithmetic, flatten transform matrices or turn
editable zeros into constants. Lazy color branches remain lazy. A multiple-output
call evaluates its requested outputs in record order; requesting an otherwise
hidden field explicitly makes that field observable. A failure leaves no
per-sample result state for the next call.

`foldGraph` remains a source-observing fold over authored identities. Its low-level
field interpreter is separate from production sampling's graph-owned preparer.
Algebra state belongs to its interpreter instance; production creates that
instance per graph. No optimization silently changes what a custom fold visits.

## Inspect the execution graph

```ts
import {inspectGraph} from '@moonweave/surfaces/core';
const view = inspectGraph(graph);
view.nodes[view.output];
view.edges; // {source: number, target: number, port: string}[]
view.nodes.map(node => ({id: node.id, sources: node.sources}));
view.eliminated;
view.statistics;
```

Edges point from earlier to later slots. Repeated uses remain separate edges, so
`add(x, x)` records both `a` and `b`. The projection records sorts, operations and
provenance without resource payloads. A child eliminated by folding has no live
representative; it is not incorrectly aliased to its parent.

Inspection is cached by compiled topology, so numeric edits can reuse it. The
atelier creates the projection when its source panel is open. Its paint-view
cache separately keeps one latest view per paint-node identity, plus the three
current color-node references. It does not retain a nested history of field
revisions or promise historical view-object identity when an older graph is
revisited.

## Equality saturation remains optional

The optional optimizer uses a small effect language, exact component laws,
source-preserving reconstruction and a compiled-cost acceptance gate. Scalar
fields and unsupported surface operations stay opaque where no law establishes
a safe rewrite. Ordinary runtime preparation does not run equality saturation.
See [OPTIMIZATION.md](OPTIMIZATION.md) for the symbolic checker, native egglog
runner and proof/interchange contracts.

## Measured CPU results

The complete paired receipt (`docs/history/0.60/roots60.json` in the source archive) records seven alternating batches,
explicit garbage collection, source fingerprints and exact value/differential
comparisons in 45 contexts. Baseline and current implementations run in one Node
process. Preparation includes importing identical v1 JSON. Sampling compares the
public APIs available in each revision: separate baseline root evaluations and
one explicit output record in the current implementation.

| Workload | Prepared nodes, v59 → v60 | Sample memo entries, v59 → v60 | Warm sampling, µs per output set | Import and preparation, µs |
| --- | ---: | ---: | ---: | ---: |
| 41 overlapping roots of an 81-node field | 1,681 → 81 | 861 → 41 | 270.88 → 20.48 | 1,262.55 → 279.62 |
| The same field through the single-root API | 81 → 81 | 41 → 41 | 8.48 → 7.93 | 253.06 → 235.06 |
| Scalar RGB, color and domain image outputs | 13 → 6 | 13 → 6 | 46.21 → 14.43 | 121.62 → 112.63 |

The overlapping workload improved by 13.23× in this run; the single-root control
changed by 1.07×. These are CPU measurements on these workloads, not GPU frame
rates or a claim of universal speedup. Output-record sampling saves repeated
context normalization and dependency evaluation; callers sampling only one root
do not have that repeated work.

### Canonical colors have a cold construction cost

The paired authoring receipt (`docs/history/0.60/values60.json` in the source archive) measures the representation change
as well as reuse. A simple canonical paint contains three explicit color nodes,
so constructing and validating its graph does more work than the old two-node
field/paint graph. The same run measures persistent value edits separately.

| CPU authoring operation | v59, µs | v60, µs |
| --- | ---: | ---: |
| Construct and normalize a paint with a trusted numeric style | 12.19 | 24.35 |
| Construct and normalize a paint with a raw numeric style | 12.50 | 26.78 |
| Construct and normalize a preset paint | 16.54 | 27.68 |
| Patch roughness on an existing immutable graph | 4.39 | 3.05 |
| Patch one color on an existing immutable graph | 4.41 | 3.48 |

Color edits start in each API's representation: decoded linear coordinates for
the canonical color node, sRGB swatches for the legacy style. The receipt keeps
both source fingerprints, isolated validation/snapshot counters, all seven
timing batches and retained-object identity checks. Graph-v2 palette records
contain references, while graph-v1 style palettes contain values; their record
counts therefore describe different representations.

The adapter edit receipt (`docs/history/0.60/edits60.json` in the source archive) includes the surrounding value binding
work. It does not show uniform improvement: a parameter edit in a two-paint
material measured 8.02 → 9.97 µs, and its paint edit measured 10.25 → 9.92 µs.
In the sixteen-paint case, parameter edits measured 23.02 → 23.85 µs and paint
edits 19.46 → 20.46 µs. Material identity, program identity, uniform-container
identity and shared compiled structure are checked in both implementations.
The large scalar control uses 125 parameters in both revisions so the new
palette nodes fit inside the same 256-node limit.

The root-sharing receipt was captured before the candidate's package-version
bump; it retains that original package metadata and the measured source hashes.
The authoring and adapter receipts record package version 0.60.0. None of these
receipts substitutes for browser rendering or GPU timing.

Reproduce against a v59 source checkout:

```sh
node --expose-gc tools/benchmark-roots.mjs /absolute/v59/source validation/roots60/fields.json
node --expose-gc tools/benchmark-values.mjs /absolute/v59/source validation/roots60/values.json
node --expose-gc tools/benchmark-edits.mjs /absolute/v59/source validation/roots60/edits.json
```

Historical scalar-CSE measurements remain in
data/sharing58-fields.json (`docs/history/0.58/data/sharing58-fields.json` in the source archive). Release-wide type,
package, compiler, shader and browser checks are recorded in
`docs/VERIFICATION.md` in the source archive.

## Primary design references

- [Three NodeBuilder](https://threejs.org/docs/pages/NodeBuilder.html) separates
  setup, analysis and generation with explicit cache ownership.
- [Three Node](https://threejs.org/docs/pages/Node.html) makes shared build
  identity and permission to cache a result in a temporary explicit.
- [MLIR CSE](https://mlir.llvm.org/docs/Passes/#-cse) constrains elimination by
  operation effects and operand semantics.
- [MLIR effects and speculation](https://mlir.llvm.org/docs/Rationale/SideEffectsAndSpeculation/)
  discusses behavior that limits movement/elimination; its CFG-region contracts
  do not establish Moonweave's field equations.
- [TypeScript module theory](https://www.typescriptlang.org/docs/handbook/modules/theory)
  explains source modules, emitted JavaScript and declaration resolution.

These references inform the design. Moonweave's semantic claims are established
by its signature, exact numerical regressions, ownership tests and measurements.

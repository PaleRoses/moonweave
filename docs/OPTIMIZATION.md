# Exact surface effects, equality saturation and graph simulation

Moonweave's optional offline optimizer runs the real `egglog==14.0.0` engine
against a small typed effect language. A finite component-demand projection
removes shadowed finish work before equality exploration. The extracted result
is verified independently, then measured with the production compiler before
acceptance. The optimizer uses the same graph-v2 grammar as ordinary authoring.

## Run an authored graph through it

Use the complete source archive with Node 24+ and Python 3.12+:

```sh
npm ci
python3 -m venv .venv-egglog
.venv-egglog/bin/python -m pip install -r tools/egglog/requirements.txt

node tools/optimize-graph.mjs authored.json optimized.json \
  --python .venv-egglog/bin/python \
  --artifacts validation/my-creature
```

The command writes a normal graph-v2 document. Existing material creation,
serialization, CPU sampling and value patches work on that result. The artifact
directory contains `job.json`, `candidate.json` and `receipt.json`. The source
and output paths must differ, so the authored program remains available.

The optional dependency is confined to authoring tools. The browser and runtime
package do not load Python or egglog. Installing Moonweave's runtime tarball is
enough to import the pure interchange and verification API:

```js
import {createOptimizationJob, verifyOptimization, applyOptimization}
  from '@moonweave/surfaces/optimize';

const job = createOptimizationJob(authoredGraph);
// Send this plain JSON job to tools/egglog/run.py.
const proof = verifyOptimization(authoredGraph, candidate);
const result = applyOptimization(authoredGraph, candidate);
const material = system.createMaterial(result.graph);
```

For a Node authoring tool in the source checkout, the existing subprocess wrapper
composes directly with graph construction:

```js
import {optimizeGraph} from './tools/optimize-graph.mjs';

const {result, candidate} = optimizeGraph(authoredGraph, {
  python: '.venv-egglog/bin/python',
  iterations: 12, rows: 50_000, timeoutMs: 30_000,
});
// result.graph is always the accepted graph or the original owned graph.
```

`examples/optimize-effects.mjs` is a complete runnable example. It applies one
image-backed finish module to several consumers, mixes them, then sets the
creature's final roughness. The command writes authored/optimized graphs and
the checked receipt into the selected directory:

```sh
MOONWEAVE_EGGLOG_PYTHON=.venv-egglog/bin/python \
  node examples/optimize-effects.mjs validation/my-finish-study
```

Executable examples and Python tools ship in the source ZIP. The runtime package
contains the pure `/optimize` interchange/checker and does not bundle subprocess
or Python machinery.

`verifyOptimization` returns the exact symbolic component comparison. Malformed
or ill-typed candidates throw. `applyOptimization` also rejects a semantic
change with an error. A valid candidate is accepted only if its compiled costs
improve; otherwise `result.graph` is the original owned graph object.

| Result reason | Meaning |
| --- | --- |
| `improved` | At least one compiled cost decreases and none increases |
| `no-improvement` | All measured compiled costs are unchanged |
| `cost-regression` | At least one compiled cost increases |
| `graph-limit` | Reification cannot preserve the source within the graph node/depth limits |

## The algebra has a concrete observation model

A surface is a product of six components:

```
Surface = Color × Slope × Roughness × Metalness × Clearcoat × Opacity
```

Color is an RGB value, slope is a two-component authored differential, and the
four finish channels are scalar values. Surface operations specify which of
those components they read and write.

| Operation | Reads from the input surface | Writes |
| --- | --- | --- |
| `coat` | Color | Color |
| `bump` | Slope | Slope |
| `relief` | Slope | Slope |
| `channels` | None for its assigned members | Only the named finish members |
| `mix` | Every component of both inputs | Every component |

These effects give exact equations. Writing the same channel twice keeps its
last assigned value. Writes to distinct channels commute. A finish write
commutes with a pigment coat, bump or relief operation. A coat commutes with
bump and relief because their inputs and outputs occupy independent components.

For a channel write `W`, pigment coat `C`, and arbitrary fields `a`, `b`, `c`, `m`:

```
W(W(s, a), b) = W(s, b)
C(W(s, a), c, m) = W(C(s, c, m), a)
```

Each write retains its original clamp. Every color interpolation, differential,
slope addition and slope multiplication retains its original grouping inside
that component. Applying these two equations can reveal a dead finish field
across an intervening pigment application.

`src/core/effects.mts` contains the full, versioned set of **24 equations**:

- Four same-channel overwrite equations.
- Six commutations between different channels.
- Twelve channel commutations through coat, bump and relief.
- Two coat commutations through bump and relief.

The equations are closed typed data. The Python bridge generates egglog
constructors and equations from that manifest. Adding a law does not require
maintaining a parallel handwritten rule list in another language.

## Terms retain identity and sharing

The optimization signature uses three sorts: surface, scalar and color.
`Coat`, `Bump`, `Relief`, `Mix` and the four single-channel writes are explicit.
Other fields and base surfaces become opaque source atoms. The mappings for
ordinary surface operations derive their ports and sorts from the main graph
signature.

Every atom identifies an original graph node. Two parameters with the same
current number remain distinct. So do distinct images, color fields and domain
expressions. The optimizer cannot inspect their current payloads, merge them by
value, replace their filtering policy or introduce a new resource. A large
image becomes one source identity in the job; its pixels remain in the graph.

Terms are a topologically ordered DAG with explicit references. `mix` is an
explicit constructor, allowing optimization within both of its branches while
preserving shared consumers. It is a barrier to effect commutations; component
demands can still pass through it without changing the grouping of any retained
interpolation.
Base `paint` and `material` nodes remain opaque; their internal color, field and
resource expressions keep their existing semantics.

Reification reuses existing structural nodes where possible and appends only
the new, reachable structural surface operations. All original graph nodes and
IDs remain available, including an overridden field that has become dead.
`compileGraph` removes dead work from the execution plan. This distinction lets
an LLM retain and edit an authored module without paying for its shadowed result
at render time. The source document can therefore have more nodes while its
compiled execution DAG becomes smaller. It remains subject to the existing
256-node and 64-depth document limits.

## Propagate component demand before equality exploration

Enumerating every legal ordering is unnecessary when a later write makes an
earlier finish value unobservable. The demand phase asks which of the four finish
components a particular consumer needs. Color and slope are always retained.
The starting demand contains all four finish channels.

Writing channel `c` removes `c` from the demand on the prior surface. If a
consumer already does not demand `c`, that write and its scalar input can be
omitted. A componentwise operator forwards the same demand to its surface inputs.
Opaque source atoms stop the analysis. No current numeric value is inspected.

The exported TypeScript definitions are the semantic owner: channel writes
already identify their channel, and Coat/Bump/Relief/Mix explicitly declare
`componentwise: true`. Python derives native projection rules from these
annotations and the existing typed input signature. It does not maintain a second
list of surface-effect rewrite equations. Unannotated legacy jobs retain the
original equation-only execution path.

For example, where `W` writes roughness, this contextual projection can produce:

```
W(Mix(W(a, old), b, weight), next)
    → W(Mix(a, b, weight), next)
```

Only the inner roughness calculation disappears. The Mix's color, slope and
other finish components keep their original grouping. A separate consumer of
`W(a, old)` still requests roughness and retains that write. Projection therefore
specializes by `(source surface, demanded components)`, never by source alone.

An internal partial-demand projection may choose different values for components
its consumer does not observe. Only the complete-demand root becomes a candidate,
and the independent six-component checker still verifies it against the complete
original graph. An interrupted projection falls back to the original root.

### A finite representation bound

Original surface constructors inhabit a separate native source sort. Projection
rules create result terms but never new source terms. The four demand bits begin
set and can only be cleared. With `S` source surfaces there are therefore at most
`16 × S` projection contexts, even when many consumers share a source DAG.
The receipt reports actual contexts and this bound.

This is a bound on the projection's state space. It is not a universal runtime
or complexity bound for the later equality search. That search still uses the
24 exact equations, sharing-aware extraction, and explicit budgets.

The ordinary input has a cheap may-write summary. Jobs with no potentially
shadowed write skip native projection entirely. This avoids adding another
native phase to gallery graphs that have no such work to remove.

## Equality is checked independently of the engine

The checker interprets both source terms and extracted terms into six symbolic
observations. It interns exact expressions in one shared table and compares the
six resulting identities. This is a second interpretation of the surface
product, rather than another rewrite pass.

For example, a finish write replaces its one symbolic component with
`clamp(sourceScalar)`. A coat replaces the color component with the original
grouped interpolation. Bump adds the original height differential to slope;
relief multiplies the prior slope by its original scale. Reordering independent
component writes produces identical observations. Reordering operations inside
a component does not.

This certifies the closed `surface-effects/1` semantics for arbitrary bindings
of its atoms. It is independent of sampled contexts and current parameter
values. It does not assert a universal identity for arbitrary floating-point
field algebra or for a particular GPU driver's transformations.

The rules deliberately exclude scalar reassociation, nested-complement
cancellation, coverage idempotence, multiplication through filtering, successive
coat reversal, bump/relief commutation, merging bumps or relief scales, and
distribution through `mix`. Concrete counterexamples live in the tests.

## Extraction cost and acceptance cost are separate

The pinned engine uses `greedy-dag` extraction. Its additive marginal proxy
counts a shared selected term once, using unit term costs by default. The raw
runner also accepts positive integer `termCostBySource` weights for experiments.
These proxy costs select a candidate; they do not determine acceptance.

The candidate is reified and compiled by Moonweave's production compiler.
Acceptance compares five existing measurements:

| Compiled cost | What it counts |
| --- | --- |
| `textureReads` | Static nearest-read ceiling, with image reconstruction sharing |
| `paintSamples` | Distinct live facet-atlas evaluations |
| `proceduralSamples` | Distinct live procedural noise evaluations |
| `uniformScalars` | Graph-owned scalar uniform components |
| `liveNodes` | Nodes in the compiled execution DAG |

Acceptance uses strict Pareto improvement: every cost must be no larger and at
least one must be smaller. A mathematically equivalent candidate that duplicates
a shared coat is rejected when it adds a live node. Removing a polish reader
does not count as a texture saving if pigment or height still consumes the same
shared image reconstruction.

This gate measures static work, not elapsed GPU time. The chosen extraction is
a heuristic; it is not a guarantee of the cheapest possible graph. The current
runner extracts one candidate and keeps the original when that candidate is not
an improvement. Alternative cost models and multi-candidate search can reuse the
same checked interchange without weakening the acceptance contract.

## Bounded runs and reproducible receipts

The default Node command allows 12 equality-search rounds, a 50,000-row threshold
and a 30-second subprocess timeout. Use `--iterations`, `--rows` and `--timeout-ms`
to set explicit limits. The finite projection phase has a separate bound of
the validated term depth plus one round. The extra round establishes the fixed
point after demand has reached the leaves; this budget is not increased by
equality search. Both phases share the row threshold and process timeout.

The row threshold is checked between native rounds; a single round may cross it.
It is not a memory quota. A timeout terminates the child process and fails the
command, without writing a successful result. If projection reaches a budget
before completing, the runner extracts the original source root and does not
run equality search. A depth-bound failure is reported as `projection-limit`.
The direct Python runner's zero-iteration mode disables both phases.

The engine receipt distinguishes `saturated`, `iteration-limit`, `row-limit`
and `projection-limit`.
It records the exact engine version, extraction mode, rounds, row count,
matched equation IDs, proxy costs, limits, one-thread configuration and hashes
of the job, manifest and generated program. Projection and search each have their
own round count, limit, matches and stop reason; the overall round count includes
both phases. The Node receipt adds semantic
verification, compiled before/after costs and the authored file hash. Receipts
are evidence; the candidate checker does not trust their claims.

## Graph simulation and counterexamples

`tools/compare-graphs.mjs` supplies finite observational comparisons. It uses
the production CPU field sampler for scalar/color values, domains and first
differentials. A small surface-record interpreter checks the actual compiled
operation wiring, including channel clamps, coats, bumps, relief and surface
mixes. Paint leaves require explicit supplied records; the tool does not
silently substitute a fabricated facets renderer.

```js
import {compareGraphs} from './tools/compare-graphs.mjs';

const evidence = compareGraphs(before, after, {
  contexts: [{
    position: [.3, .4, -.1], dx: [1, 0, 0], dy: [0, 1, 0],
    footprint: {dx: [.08, 0, 0], dy: [0, .02, 0]},
  }],
  patches: [{creatureFinish: {value: .82}}],
  paint: {base: {
    color: [.4, .5, .6], slope: [.02, -.01],
    roughness: .6, metalness: .1, clearcoat: .2, opacity: 1,
  }},
});
```

The default comparison uses exact `Object.is` component equality, including
signed zero. A report includes its sampled scope, revision/context/component
counts and the first counterexample. It labels a pass as `finite-observations`.
These observations complement the symbolic contract; they cannot establish a
new universal rewrite law.

The regression suite demonstrates that real-number reassociation changes a
floating-point result, tiny double complements lose information, separately
filtered products lose correlation, and initially equal independent parameters
diverge after editing only one of them. It also checks changed image contents,
domain transforms, live and shadowed values, and shared branches.

## Verification commands and source map

The v0.57 measurements ran the real engine on three composed applications:

| Application | Live nodes | Texture-read ceiling | Uniform components | Generated GLSL bytes | Decision |
| --- | --- | --- | --- | --- | --- |
| Independent anisotropic finish later overridden | 20 → 12 | 68 → 4 | 66 → 37 | 15,115 → 8,979 | Accept |
| Atlas still supplies pigment and height | 20 → 14 | 68 → 68 | 62 → 60 | 13,289 → 12,958 | Accept |
| Mixed branch still consumes the shared module | 25 → 25 | 68 → 68 | 71 → 71 | 15,510 → 15,510 | Retain original |

All three runs saturated in four rounds. The independent case removes the whole
anisotropic reconstruction; the shared-image case correctly retains that work.
These are static compiled-work measurements, not frame-rate claims.

Against immutable v0.56 commit `84fb8ca1406085fb42f6ad666e31fb91e16addf7`, all 15
existing gallery graphs retained their exact normalized JSON, compiled nodes,
program keys and generated shader text. They receive no claimed speedup from
these rules.

Simulation covered 45 contexts and five independent edit scenarios per workload:
675 final-output comparisons and 2,925 retained named-view comparisons, totaling
28,350 numeric components with zero differences. Native GLES3 validation linked
153 generated programs and rendered 70 images on each of sphere and shell.
The three workloads at near/far scales on both specimens produced 12
byte-identical before/after RGBA comparisons. There were no nonfinite output
pixels or GL errors. The native driver was Mesa llvmpipe; this evidence does not
imply that a browser can create a WebGL context.

These v0.57 results remain historical evidence. The complete source and Site
retain them under `docs/history/0.57/data/`: `optimization57.json`,
`optimization57-native-sphere.json` and `optimization57-native-shell.json`.
Before/after graph documents are in `docs/history/0.57/evidence/optimization57/`.

```sh
npm test
npm run typecheck
npm run test:types
.venv-egglog/bin/python tools/egglog/test_run.py
MOONWEAVE_EGGLOG_PYTHON=.venv-egglog/bin/python node tools/check-optimizer.mjs
npm run build
npm run check:package
```

The optional native integration gate runs real extraction on image-sharing,
branch-sharing and nested-Mix cases, checks source-node retention, and compares
numeric results across independent edits and footprints. Its receipt defaults
to `docs/evidence/<major.minor>/optimizer-check.json`.

To export the same five before/after pairs for native shader validation, supply
a receipt path and an artifact directory:

```sh
MOONWEAVE_EGGLOG_PYTHON=.venv-egglog/bin/python \
  node tools/check-optimizer.mjs validation/optimizer-check.json validation/optimizer-cases
MOONWEAVE_OPTIMIZATION_CASES=validation/optimizer-cases \
  python3 tools/validate-texturing-gpu.py validation/optimizer-native
```

The directory contains graph documents, edit scenarios and a versioned
`cases.json` manifest consumed by the existing native validation path. Both
nested-Mix variants are included: an overwritten finish and a finish still used
by a separate consumer.

For paired scaling evidence against an immutable checkout:

```sh
MOONWEAVE_EGGLOG_PYTHON=.venv-egglog/bin/python \
  node tools/benchmark-optimizer.mjs /absolute/path/to/baseline-checkout
```

The benchmark uses alternating paired batches of fresh native engines and checks
the extracted candidates through the real importer, compiled cost gate and
finite observations. Python startup and Node compilation are outside its timing.
It reports small-input overhead as well as larger-input improvements. Its receipt
defaults to `docs/evidence/<major.minor>/optimizer.json`.

Recreate the measurement baseline from the cited commit's `src/`, `lab/` and
`package.json` with `git archive`; include `provenance.json` with `commit`,
`version` and `source` fields. Then run:

```sh
MOONWEAVE_EGGLOG_PYTHON=.venv-egglog/bin/python \
  node tools/measure-optimization.mjs validation/baseline56 validation/optimization
MOONWEAVE_OPTIMIZATION_CASES=validation/optimization \
  MOONWEAVE_NATIVE_SPECIMEN=sphere \
  python3 tools/validate-texturing-gpu.py validation/native-sphere
MOONWEAVE_OPTIMIZATION_CASES=validation/optimization \
  MOONWEAVE_NATIVE_SPECIMEN=shell \
  python3 tools/validate-texturing-gpu.py validation/native-shell
```

| File | Responsibility |
| --- | --- |
| `src/core/effects.mts` | Typed effect signature, equations and symbolic product interpretation |
| `src/core/optimize.mts` | Export, typed candidate validation, reification and compiled cost acceptance |
| `src/optimize.mjs`, `src/core/optimization-types.mts` | Optional public API and its owning type contracts; declarations are generated |
| `tools/egglog/run.py` | Real engine execution and structured DAG extraction |
| `tools/egglog/language.py` | Closed typed job validation and language lowering |
| `tools/egglog/demand.py` | Signature-derived finite component-demand projection |
| `tools/optimize-graph.mjs` | Bounded subprocess and graph-file workflow |
| `examples/optimize-effects.mjs` | Runnable composed finish application |
| `tools/check-optimizer.mjs`, `tools/benchmark-optimizer.mjs` | Native integration gate and paired scaling measurements |
| `tools/compare-graphs.mjs` | Finite field and surface-record observations |
| `tools/optimization-fixtures.mjs`, `tools/measure-optimization.mjs` | Reproducible application workloads and compatibility evidence |

## Primary sources behind these choices

- [egglog-python 14.0.0 release and requirements](https://pypi.org/project/egglog/14.0.0/).
- [Official changelog: sharing-aware extraction, additive DAG costs and its heuristic scope](https://egglog-python.readthedocs.io/latest/changelog.html).
- [Official scheduling tutorial: bounded iterations, analysis and rulesets](https://egraphs-good.github.io/egglog-tutorial/04-scheduling.html).
- [Structured low-level extraction bindings](https://egglog-python.readthedocs.io/latest/reference/bindings.html).
- [Egglog: Better Together, equality saturation and Datalog](https://arxiv.org/abs/2304.04332).
- [LLVM demanded bits: queries are about both instructions and individual uses](https://llvm.org/doxygen/classllvm_1_1DemandedBits.html).
- [DataFusion projection pushdown: source work follows requested columns](https://docs.rs/datafusion/latest/datafusion/catalog/trait.TableProvider.html).

Moonweave calls egglog as a separately installed MIT-licensed dependency. It does
not vendor or transliterate the engine. The effect equations and product
interpreter here implement Moonweave's existing material semantics.

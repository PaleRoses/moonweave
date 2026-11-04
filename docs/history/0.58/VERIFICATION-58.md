# Moonweave 58 verification

Release **0.58.0** makes the graph ownership, compiler, CPU field preparation,
color math and optional optimizer strict TypeScript. It adds shared preparation
of repeated pure scalar expressions and an inspection API/UI derived from the
actual compiled DAG. Graph-v1 retains six sorts and 25 operations; the offline
optimizer retains its existing 24 equations.

Baseline: **0.57.0**, immutable source commit
`ffd7785e34df90bca00c831139f94166654caaa7`. npm dependency maps are unchanged;
package-lock changes only the project version. Earlier equality-saturation
release evidence is preserved in [VERIFICATION-57.md](../0.57/VERIFICATION-57.md).

## Functional and type checks

**439 tests passed, zero failures, zero skips.** [tests.tap](tests58.tap) records
this release's complete run. Strict application/implementation typechecking and
public API fixtures pass. Six pinned native egglog integration tests pass.
No `any`, `@ts-ignore` or `@ts-nocheck` escapes were added to the migrated modules.

| Boundary | Evidence |
| --- | --- |
| CPU sharing | Repeated pure scalar operators prepare and sample once per representative; nine focused tests cover identities, source-observing folds, root subsets, image policies, exact color/lazy errors and reference mapping |
| Compiler | All 15 gallery graphs retain exact serialization, compiled nodes, program keys, costs, intervals, value bindings and diagnostics |
| Provenance | Shared aliases map to surviving compiled IDs; folded-away children and unreachable definitions map to null; inspection survives value edits by identity |
| Optimization | All 18 gallery/optimizer cases retain exact exported jobs, candidate jobs, symbolic proofs and application results; manifest remains 7,094 bytes with 24 equations |
| Numerical migration | Color matrices, operation order and type-erased numerical implementation match v57 |
| Package | Four public entries, generated optimizer/inspection declarations, shared module identities and renderer-free core consumption |

Compiler and optimizer receipts:
[data/sharing58-compiler.json](data/sharing58-compiler.json),
[data/sharing58-optimizer.json](data/sharing58-optimizer.json).

## Paired CPU measurements

[The full receipt](data/sharing58-fields.json) includes source fingerprints,
environment, all seven alternating baseline/current timing batches and exact
comparisons over 45 contexts per workload. All **225 context comparisons** match
exactly, including values and first differentials. Timings below are microseconds
per operation; preparation includes parsing/importing a fresh serialized graph.

| Workload | Prepared nodes | Warm sampling, v57 → v58 | Import + preparation, v57 → v58 |
| --- | --- | --- | --- |
| Two repeated scalar branches | 6 → 4 | 5.504 → 5.027 | 27.245 → 32.593 |
| Sixteen repeated scalar branches | 113 → 12 | 13.333 → 5.058 | 332.147 → 382.628 |
| 32 independent parameters | 63 → 63 | 6.691 → 6.809 | 164.218 → 189.643 |
| Sixteen filtered readers/products | 50 → 9 | 14.487 → 10.582 | 185.818 → 232.990 |
| Identity-sensitive Oklab mix | 11 → 8 | 11.945 → 11.810 | 32.366 → 49.838 |

The repeated scalar tree samples **2.64× faster** and the filtered-reader case
**1.37× faster** in this run. The latter already shared image reconstruction in
v57; the additional gain removes redundant projections and scalar arithmetic.
Small/control differences are not promoted as speed gains. Preparation remains
slower: the repeated-tree case amortizes its additional preparation time after
roughly six samples in this measurement. Reuse the prepared sampler for repeated
queries. These measurements do not establish browser frame-rate gains or a
universally fastest representation.

A bounded cleanup removed a second mapped-node allocation from preparation;
[data/sharing58-preparation.json](data/sharing58-preparation.json) records its
comparison with the initial v58 implementation. No sampling-time key work was
introduced. [Material-edit measurements](data/sharing58-edits.json) also retain
program identities and unchanged rounding/color-decoding work; nested 24-domain
cases improved in this run, while small cases show mixed differences.

## Native generated shaders

The current source passed **153 actual generated program compile/link checks**
and **70 sphere renders** through native Mesa GLES3. All 70 images match the
v57 native reference pixels byte for byte. The six paired before/after optimizer
renders also remain byte-identical. No GL errors or nonfinite pixels were found.
Resource value/differential parity passes at the unchanged 3e-6 tolerance; all
other native color and height parity checks pass.

- [Current native report](data/sharing58-native.json)
- [70-image compatibility hashes](data/sharing58-native-compatibility.json)

This uses llvmpipe software rendering, not a browser WebGL context or a hardware
frame-time benchmark. All 48 source fingerprints in the native report match the
checked source; all 38 runtime fingerprints in the CPU sharing receipt match.

## Browser verification

The updated atelier displays its actual compiled graph. A nine-node authored
example displays seven live nodes and one multiply result used by both `add`
ports. Selecting that multiply reveals `leftHeight` and `rightHeight`; editing
`gain` from .7 to .82 retains the sharing. Two Undo actions restored the original
surface JSON exactly. [browser58.json](browser58.json) and the
[screenshot](../../evidence/sharing58/graph.jpg) record the check.

The cloud browser cannot obtain WebGL2, so the live 3D preview remains unavailable
there. Graph editing, inspection and undo were verified. No browser download or
clipboard-delivery claim is made for this pass.

## Package and source release

The actual npm archive passed isolated installation and runtime tests, strict
NodeNext/ES2022 typechecking with `skipLibCheck: false`, absent Three/Solid/Effect
peers for the pure core, and the injected Three adapter test. Runtime declaration
imports resolve with implementation TypeScript absent. The npm archive and
portable ZIP contain the same payload.

[package58.json](package58.json) records the final archive identity, inventory and
complete source rebuild result. The source rebuild compares every generated
output, including all three downloadable archives, byte for byte. The package is
prepared for npm consumption; no registry publication is performed.

[bundle58.json](bundle58.json) records the new atelier footprint. The optional
optimizer is still excluded from ordinary core/renderer entry graphs; Python and
egglog remain offline tools. No npm dependency was added.

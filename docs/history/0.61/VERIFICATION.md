# Moonweave 61 verification

Release **0.61.0** is a focused refinement of the canonical graph, authored mark
system and atelier introduced in 0.60. Three passes covered implementation,
cross-review of the new ownership/migration boundaries, and executed integration.
Graph **version 2**, six sorts, 26 operations and all existing gallery images remain.

Baseline: **0.60.0**, immutable commit
`04969922822a5d71875e2c7daffd4ccec7ea9bd2`.
[VERIFICATION-60.md](../0.60/VERIFICATION-60.md) and [tests60.tap](../0.60/tests60.tap) preserve
that release's evidence. Earlier benchmark results are not relabeled as this release.

## Functional and type checks

**505 tests pass, with zero failures and zero skips.** [tests.tap](tests.tap)
contains the full run. Strict source/atelier typechecking and public API fixtures
pass. Added regressions cover normalized node borrowing, graph-wide validation,
incremental expression recovery, sparse author arrays, inactive mark effects,
full affine inverses, compact sessions, legacy migration and extended palette edits.

Persisted data enters `materialGraph` as unknown input. The constructor owns
validation; the session reader does not assert that external data is a graph.

## Canonical ownership and expression recovery

The existing graph-owned expression map now serves as the DAG fold's memo.
Recovering another root visits only definitions that have not been reified.
No second expression traversal or persistent cache was introduced.

`normalizeNode` and the internal `patchNodeValues` publish the same private
validation proof. Reconstructed documents can borrow those exact immutable
nodes, including persistent value edits. They still validate every connection,
sort, cycle, depth and aggregate image budget. Generic frozen caller objects
never acquire this proof by shape or `Object.isFrozen`.

Ownership snapshots now preserve array length. A trailing hole can no longer
shrink malformed RGB values, matrices or color ramps into smaller valid input.
Node imports, mark lists, tuples, paths and ordered zone applications traverse
densely and reject missing elements at their existing boundaries.

[reification61.json](reification61.json) records seven alternating paired batches
against the immutable baseline, with parsing outside the measured operation:

| Observation | v0.60 | v0.61 |
| --- | ---: | ---: |
| Source visits for 41 overlapping roots | 1,681 | 81 |
| Owned expressions retained | 81 | 81 |
| Recovery of those roots, median | 435.75 µs | 106.49 µs |
| Same 81-node graph, one root | 95.20 µs | 105.89 µs |

All 41 canonical root documents match exactly. The overlapping case improves
**4.09×**. The single-root control is about **11% slower** in this run. This is a
specific CPU authoring measurement, not a universal speedup or rendering result.

## Mark compilation and unused work

Canonical `markProgram` values are borrowed by identity on normalization,
serialization and compilation. Raw caller programs still copy and validate
all samples. The private program proof retains no compiled or baked state.

Only emitted dabs contribute finish/height metadata and acquire zone placements.
Transparent marks and zero-pressure paths therefore do not retain empty finish
images or bump nodes. Unused authored zones remain portable and validated, but
have no filtering plan or per-sample scratch slot. One affine inverse helper
validates all six inverse coefficients both for authored transforms and for
expanded placements, including translations on unused zones.

[marks-cleanup61.json](marks-cleanup61.json) records alternating paired batches:

| Workload | v0.60 | v0.61 |
| --- | ---: | ---: |
| Raw program with a 512² mask, normalization | 18.96 ms | 18.92 ms |
| Already-normalized program, normalization | 2,997.18 µs | 0.139 µs |
| Compile that owned program | 3,201.26 µs | 4.44 µs |
| 64² bake with 1,000 unused zone aliases | 25.39 ms | 11.62 ms |
| Same bake without unused zones | 12.23 ms | 11.60 ms |

The owned normalization measurement demonstrates removal of a repeated image
scan; it is not an end-to-end painting speedup. A separate inactive-mark fixture
retains every baked image component exactly while lowering **24 → 11 graph
nodes**, **5 → 2 images**, and removing an empty height operation.

[marks61.json](marks61.json) reruns the full painted study: 21 marks, 189 dabs,
five resources and 212,992 components. The facet-based gallery remains 22 nodes.
Warm medians on this host are 0.208 ms to compile and 231.83 ms to bake at 128²;
these absolute observations are separate from the paired comparison above.
All existing color, filtering, ordered deposition and numerical quadrature
contracts remain as described in [COLOR.md](../../COLOR.md) and [MARKS.md](../../MARKS.md).

## Compact sessions and direct palette controls

Session format 2 stores one full reset baseline plus the current graph's
changed nodes and references to unchanged baseline IDs. Decoding borrows those
validated records before ordinary graph validation. It preserves node, image
resource and sample-array identity across revisions without equal-pixel interning.

The version-1 reader compares normalized same-ID records once during migration,
so an existing edited save also receives the compact representation. Different
IDs and changed values remain distinct. The version-2 path does not compare or
merge separately authored equal objects.

[session61.json](session61.json) imports and exercises both real codecs:

| Painted carapace session | v0.60 | v0.61 |
| --- | ---: | ---: |
| Unedited | 1,170,632 bytes | 1,170,632 bytes |
| One roughness edit | 2,341,114 bytes | 1,171,073 bytes |
| Decode and encode again | 2,341,114 bytes | 1,171,073 bytes |
| Shared restored nodes | 0 | 21 |
| Shared image nodes / resources / sample arrays | 0 / 0 / 0 | 5 / 5 / 5 |

The edited session is **49.98% smaller**. Migrating an existing edited version-1
save produces exactly the same compact bytes as a freshly authored version-2
save. A second fixture with an already-patched image baseline also preserves
sharing and shrinks from 2,347,804 to 1,174,418 bytes. Tests retain the source draft,
reset baseline, distinct IDs, new edit/undo and reset/undo behavior.

Literal palette connections expose extended linear RGB controls directly in
Paint, reusing the existing color editor and undo path. Shared fields visibly
remain shared. A varying field offers **Sample at rest origin**, accurately
stating that the action creates a constant rather than copying spatial variation.

## Native rendering and gallery compatibility

[gallery61.json](gallery61.json) compares all 16 gallery graphs and compiled
plans, all generated shader declarations/evaluation code, and 64 adapter binding
and assembled shader pairs across Three r140/r187 and local/attribute coordinates.
All compared representations match exactly. This source-assembly check itself
is not a GPU execution test.

[native61.json](native61.json) and [native61-shell.json](native61-shell.json)
each record **141 programs compiled and linked** and **64 renders**, through
native surfaceless EGL/GLES3 with Mesa llvmpipe. They use the actual installed
Three physical chunks and engine assemblers and include CPU/GPU field probes,
associated deposition, live edits, finite-output guards and the painted gallery.

[migration61.json](migration61.json) verifies the old report fingerprints against
the immutable baseline and current report fingerprints against current source,
then compares decoded pixels. **All 128 sphere and shell renders are byte-identical
in RGBA to v0.60.** These are executed software-driver checks, not a frame-rate
measurement or a claim about every browser/GPU.

## Browser and package release checks

[browser61.json](browser61.json) records the actual managed Chrome interactions.
The 0.60 painted-carapace save opens in 0.61 with 22 nodes and five images.
Editing the Body field's extended linear R value to 1.25 changes its canonical
color node; Undo and Redo recover the exact corresponding source. Autosave and
reload recover the edited source exactly. Reset then recovers the original
source exactly. [evidence/palette61.jpg](../../evidence/palette61.jpg) shows the new
controls in the running atelier.

This cloud browser still cannot obtain WebGL2, so its reference image remains
explicitly static. The native rendering checks above provide the executed
graphics evidence. The export control started a browser download, but the browser
reported that download as failed; file delivery is **not verified**. No cause was
established, and the application was not changed to work around browser policy.
The download notices now say **Graph download requested** and **View download
requested**: the application observes dispatch, not completion. This follows the
[HTML download contract](https://html.spec.whatwg.org/multipage/links.html#downloading-resources),
which allows the browser to stop a requested download.
During reload testing, a separate project temporarily occupied the shared preview
service. After restoring Moonweave, the exact reload check passed.

[package-check61.json](package-check61.json) records an isolated install of the
actual runtime tarball: 75 files, generated source-free declarations, no `any`
in those declarations, core import without peers, shared module identity,
the Three adapter, and strict NodeNext TypeScript consumers all pass.

[package61.json](package61.json) records the complete **361-file source archive**
rebuild and byte-for-byte comparison of **all 198 distribution outputs**, including
all three archives. The portable ZIP and npm tarball contain identical runtime files.
The rebuild uses the pinned installed dependency tree; it does not claim a fresh
network install. Source and runtime downloads include the current guides, exact
implementation and reproducible measurement tools. The npm archive remains
unpublished to the registry.

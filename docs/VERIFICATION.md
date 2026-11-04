# Moonweave 0.62 verification

Release **0.62.0** reduces repeated image analysis, sparse-zone raster work and
optimizer search growth, and prepares a portable source tree for a standalone
repository. The graph remains **version 2**, with six sorts and 26 operations.
The source map and public module boundaries remain in [AGENTS.md](../AGENTS.md).

All paired measurements use immutable **0.61.0**, commit
`58bcd91416ace8f7a18ce9110b54566a89503a3d`, as the baseline. Its report is preserved
in [history/0.61/VERIFICATION.md](history/0.61/VERIFICATION.md). Current receipts
are under `docs/evidence/0.62/`; historical measurements are not relabeled.

## Executed source checks

| Check | Result | Evidence |
| --- | --- | --- |
| JavaScript behavioral suite | 512 passed; no failures or skips | [Full TAP](evidence/0.62/tests.tap) |
| Strict source and atelier TypeScript | Passed | [Source check](evidence/0.62/typecheck.txt) |
| Public TypeScript consumers | Passed | [Consumer check](evidence/0.62/public-types.txt) |
| Pinned real egglog engine | 10 passed | [Python tests](evidence/0.62/egglog-tests.txt) |
| Portable source/archive boundaries | 5 passed | [Archive tests](evidence/0.62/archive-tests.txt) |

New regressions cover image-channel ownership, zero-address range widening,
resource replacement, conservative filtered zone support, repeated sample
generations, shared zone values, disjoint supports, all sixteen finish-demand
masks, nested Mix consumers, incomplete projection fallback and sparse candidate
arrays. Public declarations continue to derive from their checked owners.

## Image analysis belongs to the immutable image

The image's existing ownership registry now retains up to three lazy channel
range pairs. A reader borrows its channel summary; zero extension widens that
reader's range locally. Changing a domain, filter, topology or downstream
consumer cannot invalidate the immutable pixels' minimum and maximum. Replacing
the image creates a new owner and computes its summary when requested. Raw caller
images still copy and validate at the ownership boundary.

For `R` readers, `P` texels and `C` requested stored channels, the image-scanning
term changes from **O(RP)** to **O(CP + R)**, with **C ≤ 3**. Repeated candidate
graphs borrowing the same resource also reuse the summary. No second resource
registry, graph history or invalidation manager was introduced.

[image-analysis.json](evidence/0.62/image-analysis.json) varies dimensions and
reader count independently: 32², 128² and 512² images with 1, 4, 16 and 64 readers,
plus a three-channel case. All thirteen retain exact graph data, compiled nodes,
ranges, opacity bounds, costs, source mappings and program keys. Production-loop
instrumentation runs separately from uninstrumented timing.

| 512² scalar image, 64 readers | 0.61 | 0.62 |
| --- | ---: | ---: |
| Cold compilation: actual range-component visits | 16,777,216 | 262,144 |
| Cold compilation, median | 218.60 ms | 3.14 ms |
| Replaced image, median | 205.25 ms | 2.26 ms |
| New topology borrowing an already-analyzed image: range visits | 16,777,216 | 0 |
| That topology's compilation, median | 236.17 ms | 1.44 ms |
| Raw image copy + graph construction/validation + compilation | 237.32 ms | 18.86 ms |

The RGB case performs 49,152 range-component visits instead of 1,032,192: one
scan for each stored channel. Image copying is not eliminated. Raw 512²
normalization is 13.90 → 13.71 ms, and complete single-reader construction/compile
is 19.43 → 17.63 ms. A small 32² single-reader cold compile is 0.101 → 0.105 ms,
slightly slower in this run.

Timings use seven alternating paired batches with eight operations per batch,
separate warmup and explicit GC. Graph preparation is outside compile-only
timing; the separately labeled raw-input cases include it. These measurements
concern CPU authoring and analysis, not GPU rendering.

## Sparse mark work follows filtered support

The raster index applies
`support(brush × zone) ⊆ support(brush) ∩ support(zone)` before inserting dabs
into tiles. Both bounds include filtering support, including virtual coarse
levels and anisotropic taps. Disjoint supports insert no candidates. Retained
candidates keep their authored order and deposition arithmetic.

Zone sample values use bake-local generation markers instead of clearing every
zone slot for every sample. With `Z` active zones, `Q` samples and `T` actual
zone touches, this removes the **O(QZ)** clearing term; initialization and sample
reuse cost **O(Z + Q + T)**. The existing image budget bounds the maximum sample
count to 1,290,496, below the 32-bit generation counter's wrap point. No scratch
state escapes a bake. `MarkBakeStats.zoneSamples` exposes actual zone sampling.

[mark-zones.json](evidence/0.62/mark-zones.json) compares identical authored
programs and every component of all five output images. For one finite zone per
16×16 tile, `Q = 256N`; the candidate family changes from **256N²** to **256N**:

| Marks / local zones | Candidate tests, 0.61 → 0.62 | Bake median, 0.61 → 0.62 |
| ---: | ---: | ---: |
| 4 | 4,096 → 1,024 | 6.64 → 2.87 ms |
| 16 | 65,536 → 4,096 | 39.10 → 4.98 ms |
| 36 | 331,776 → 9,216 | 180.71 → 10.95 ms |
| 64 | 1,048,576 → 16,384 | 570.13 → 19.95 ms |

A second family keeps identical tile references and candidate sets while varying
16–1,024 broad zones with local brushes. At 1,024 zones the median is
46.76 → 24.93 ms, isolating reset work from spatial culling. The single un-zoned
brush control is 33.03 → 29.76 ms; its batches are variable and no asymptotic gain
is claimed there. Timings use seven alternating paired batches of already-compiled
programs. Dense overlapping marks still require their actual contributions;
this is not a linear-time guarantee for every bake.

## Egglog projects demand before exploring equations

The optional optimizer uses the real pinned **egglog 14.0.0** engine. Its finite
demand phase is generated from the existing TypeScript effect signature: channel
writers identify their component, and Coat/Bump/Relief/Mix explicitly promise
componentwise behavior. The 24 exact effect equations remain unchanged. Python
owns no parallel handwritten equation list.

Source surface constructors inhabit a separate native sort. Projection creates
result terms but cannot create new source inputs. Four finish bits allow at most
**16 contexts per source surface**. Color and slope always remain observed. A
channel write clears that channel's demand on its prior surface; componentwise
operations forward remaining demand to each surface input. Separate consumers
can therefore retain different projections of one module.

Only a complete-demand root becomes a candidate. A partial projection is never
asserted equal to its full source surface. The independent TypeScript checker
still compares all six symbolic surface observations, including authored
floating-point grouping and source-atom identities. Reification retains every
original node and ID for editing; the compiler prunes unused execution work.
Acceptance requires at least one lower compiled cost and no higher cost among
texture reads, paint samples, procedural samples, scalar uniforms and live nodes.

### Scaling through the real engine

[optimizer.json](evidence/0.62/optimizer.json) measures six chain sizes in seven
alternating paired batches of fresh native engines. Timing includes validation,
program generation/parsing, projection, equation search, extraction and decoding.
Python process startup and Node graph compilation are outside this measurement.
Both versions receive a 100-round search allowance and a 50,000-row threshold;
**every measured run saturates**, and the compiled extracted costs match.
The larger allowance compares completed searches, not a finished new run with
a truncated baseline run.

| Alternating finish/coat layers | Native rows, 0.61 → 0.62 | Rule matches, 0.61 → 0.62 | Median, 0.61 → 0.62 |
| ---: | ---: | ---: | ---: |
| 4 | 51 → 32 | 45 → 10 | 3.67 → 4.92 ms |
| 8 | 211 → 56 | 414 → 18 | 4.81 → 6.22 ms |
| 12 | 547 → 80 | 1,651 → 26 | 6.53 → 6.44 ms |
| 16 | 1,123 → 104 | 4,556 → 34 | 9.48 → 7.46 ms |
| 24 | 3,251 → 152 | 19,850 → 50 | 24.22 → 10.58 ms |
| 30 | 5,953 → 188 | 45,415 → 62 | 41.90 → 12.61 ms |

The 30-layer workload uses 61 projection contexts. Four- and eight-layer cases
pay roughly 1.2–1.4 ms of additional phase overhead. Jobs without a potentially
shadowed write skip projection entirely. The finite context bound is not a
universal runtime bound for later equality search, and greedy-DAG extraction is
a heuristic rather than a global-optimum guarantee.

Default authoring limits remain 12 equality-search rounds, a 50,000-row threshold
and a 30-second subprocess timeout. Projection has its own depth-plus-one round
bound and shares the row threshold/timeout. An unfinished projection extracts
the original source and skips search. Row thresholds are checked between native
rounds, so one round can exceed the threshold; it is not a hard memory quota.
Timeouts terminate the child and fail the command. Phase receipts distinguish
saturation, iteration, row and projection limits.

### Composed applications and editable inputs

[optimizer-check.json](evidence/0.62/optimizer-check.json) records five complete
runs through real extraction, the independent checker and the compiled cost
gate. [The fixture manifest](evidence/0.62/optimization/cases.json) and its
before/after graphs and edit patches travel with the source ZIP.

| Application | Texture-read ceiling | Live nodes | Decision |
| --- | ---: | ---: | --- |
| Independent anisotropic finish overwritten | 68 → 4 | 23 → 15 | Accept |
| Same image still supplies pigment and height | 68 → 68 | 23 → 17 | Accept |
| Separate branch still consumes the finish module | 68 → 68 | 28 → 28 | Retain original |
| Nested Mix with overwritten finish | 64 → 0 | 17 → 14 | Accept |
| Nested Mix with an independent live consumer | 64 → 64 | 18 → 18 | Retain original |

All original nodes survive reification. Independent parameter, image and field
edits pass the symbolic checker again. Finite CPU comparison covers 45 contexts
and three or five edited revisions per fixture: **945 output observations and
8,505 numeric components, with zero differences**. Paint leaves are explicitly
supplied opaque records for those finite comparisons; this is not a claim that
the CPU tool renders facets or proves new general laws.

The runnable [optimize-effects.mjs](../examples/optimize-effects.mjs) was executed
successfully. It builds the nested-Mix module, removes all 64 static image reads,
and writes authored/optimized graphs plus a checked receipt. The pure `/optimize`
API stays renderer-free; Python is confined to source authoring tools.

## Gallery and actual native rendering

[gallery.json](evidence/0.62/gallery.json) compares all 16 gallery graphs,
compiled plans, generated shader declarations/evaluation code, and 64 adapter
binding/shader pairs across Three r140/r187 and local/attribute coordinates.
Every compared representation matches the baseline exactly. This source-level
assembly comparison is separate from driver execution.

[native.json](evidence/0.62/native.json) and
[native-shell.json](evidence/0.62/native-shell.json) each record **173 programs
compiled and linked and 84 renders**, using surfaceless EGL/GLES3 with Mesa
llvmpipe. The suite exercises actual installed Three physical shaders,
finite-output guards, resource/color/differential probes, live edits, the painted
gallery and the five optimizer applications. Every optimizer before/after pair
matches in decoded RGBA at near/far views on both specimens: **20 exact pairs**.

[migration.json](evidence/0.62/migration.json) verifies baseline report source
fingerprints against the immutable 0.61 checkout and current fingerprints against
this source, then compares decoded images. **All 128 existing sphere/shell renders
are RGBA-byte-identical to 0.61.** There are no nonfinite-output failures or GL
errors in the executed native suite.

This is a software-driver correctness check, not browser WebGL verification,
hardware GPU coverage or interactive frame-rate measurement. This round changes
the core, authoring tools and packaging; the browser UI was not retested. The
previous cloud-browser WebGL2 limitation and unverified download completion remain
recorded in the [0.61 report](history/0.61/VERIFICATION.md).

## Portable repository and release archives

The source ZIP preserves `src/`, `lab/`, `examples/`, `tests/`, `tools/`, current
guides, versioned evidence, the lockfile, contributor/source-map instructions,
notices and a pinned GitHub check workflow. Historical receipts moved into
`docs/history/<version>/`; their data is retained. Defaults for new measurement
receipts derive their release folder from the package version.

One source-membership policy owns packing and verification. It excludes Site
configuration, Git metadata, local environments, installed dependencies, caches
and generated output. Selected file/directory symlinks reject. ZIP member order,
timestamps, permissions and platform metadata are fixed. The source check
compares membership and bytes with the maintained checkout before rebuilding.

[package-check.json](evidence/0.62/package-check.json) records an isolated install
of the actual **75-file runtime tarball**. Generated source-free declarations,
the absence of `any` in those declarations, a core import without peers, shared
module identity, the Three adapter and strict NodeNext consumers all pass.

[package.json](evidence/0.62/package.json) records the **412-file source ZIP**
rebuild and byte-for-byte comparison of **all 233 distribution outputs**, including
all three archives. The portable runtime ZIP contains exactly the npm tarball's
file bytes. This rebuild uses the pinned installed dependency tree; it does not
claim a fresh network dependency installation.

The GitHub workflow is prepared with pinned actions and local equivalents of its
source/type/egglog/package checks. It has not run on a GitHub remote. Moonweave's
own license remains `UNLICENSED`, and the development package remains private;
the runtime archive is installable locally and unpublished to npm.

## Research and attribution

[RESEARCH.md](RESEARCH.md) and [OPTIMIZATION.md](OPTIMIZATION.md) map the decisions
to egglog scheduling/extraction, LLVM use-specific demand, PBRT image ownership,
OpenImageIO channel statistics, sparse accumulator techniques and reproducible
archive guidance. This round copies no upstream implementation. Existing adapted
color/spectral data retains its notices in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

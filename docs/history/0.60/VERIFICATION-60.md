# Moonweave 60 verification

Release **0.60.0** closes four architectural seams: declarations come from their
owning TypeScript implementations; every paint uses color-expression ports; a
zone owns all its inputs in one sharing-preserving snapshot; and authored marks
have a portable grammar, managed color boundary, deterministic compilation,
filtered bake and ordinary graph application.

Graph **version 2** has **six sorts and 26 operations**. The new `deposit`
operation applies associated pigment and independently covered finish channels.
Version-1 graphs and flat legacy recipes migrate explicitly at import. The live
representation has no style swatches or palette precedence rule.

Baseline: **0.59.0**, immutable commit
`d511c2ae17735ef718753e50c8489f66bb431b2d`.
[VERIFICATION-59.md](../0.59/VERIFICATION-59.md) and [tests59.tap](../0.59/tests59.tap) preserve
the preceding release's evidence.

## Functional and type checks

**487 tests pass, with zero failures and zero skips.** The complete run is
recorded in [tests60.tap](tests60.tap). Strict source/atelier
typechecking and public API fixtures pass. Tests cover canonical migration and
material updates, graph ownership, shared CPU outputs, color management, mark
expansion, resource sampling, deposition, renderer lifetimes and optimization.

Regressions found and repaired during this release:

- An equal-valued material update could retain an obsolete recipe identity and
  lose a later palette-sharing request. The adapter now keeps the latest authored
  recipe even when its compiled plan is unchanged.
- Separately owning zone properties could split a repeated raw expression. One
  snapshot owns coverage, color, height and channels with shared descendants.
  A zone name is a label; `named()` alone assigns graph IDs.
- A one-ULP change in collinear stroke length could add a nearly coincident
  endpoint dab. Expansion schedules endpoints consistently and includes attempted
  zero-pressure samples in its budget.
- Mark JSON could repeat shared image pixels. Its indexed image table now
  preserves references and rejects dangling or unreferenced resources.
- Value-only patches re-normalized validated ports. They now normalize editable
  values while preserving immutable connection records.
- Pretty-printing embedded images put 213,236 lines into the painted example's
  source textarea. Canonical JSON now groups numeric arrays into bounded rows:
  3,539 lines and 1,418,363 characters instead of 3,515,267 characters. All samples,
  values and the schema roundtrip unchanged; no resources are elided.

Source contains **zero handwritten .d.mts files**. The package contains **33
generated declarations** in the public dependency closure. Packed declaration
ASTs are checked for `any` type nodes. Public signatures and overloads are
checked beside their implementations, without a parallel declaration file.

## Native rendering and migration

[native60.json](native60.json) and [native60-shell.json](native60-shell.json)
each record **141 generated programs compiled and linked**, and **64 renders**,
through native surfaceless EGL/GLES3 with Mesa llvmpipe. Programs use the actual
Three r140/r187 physical chunks and each engine's WebGLProgram assembler.

Both runs cover the complete gallery; new painted marks on sphere and shell;
associated deposition against an independently assembled component reference at
near and far scales; canonical palettes; live patches; coordinate frames; finish
composition; and height-only shading. GPU probes compare CPU color, procedural,
differential and filtered-image sampling, including finite addressing and virtual
coarse mip levels. Shader guards check non-finite output, normal, pigment and slope.

All **58 common sphere render cases** from v0.59 are **byte-identical in RGBA**.
[migration60.json](migration60.json) records the comparison and image hashes.
New marks/deposition cases are additional checks, not compatibility pairs.

These are executed native checks on this software driver. They are not a claim
that every browser/GPU was tested or a frame-rate measurement.

## Color and authored marks

[COLOR.md](../../COLOR.md) defines extended linear Rec709 working values; tagged sRGB,
Display P3, Oklab and OKLCH conversions; explicit display gamut mapping; and image
encoding/decoding. Display mapping follows CSS Color 4 local-MINDE in OKLCH.
The complete W3C notice ships in both source and runtime archives.

This is an **SDR D65 RGB pipeline**. ICC interpretation, arbitrary white-point
adaptation, HDR tone mapping and photographic rendering intents are outside its
contract. Extended values survive until an explicit display or reflectance boundary.

[MARKS.md](../../MARKS.md) defines ordered affine dabs and pressure polylines, brush
images, finite zones, independent finish decisions and additive covered height.
Compilation expands strokes once; baking bins footprints spatially. Application
uses ordinary immutable images, filtered readers, `deposit` and `bump`.
Rendering has no per-dab loop.

Pigment and coverage are integrated together. Each supplied finish channel has
its own associated value and coverage; omitted channels preserve the base.
Filtering acts on correlated quantities before deposition. Covered height feeds
`bump` directly, without applying coverage twice.

[marks60.json](marks60.json) records a deterministic run:

| Observation | Result |
| --- | ---: |
| Authored marks / expanded dabs | 21 / 189 |
| Canonical authored program | 81,154 bytes |
| Baked resources / components at 128² | 5 / 212,992 |
| Spatial bins | 64 |
| Candidate dab tests | 493,568 |
| Unindexed sample × dab count | 12,386,304 |
| Warm compile median, seven runs | 0.737 ms |
| Warm bake median, seven runs | 234.90 ms |

Candidates are 3.985% of the unindexed count, not a measured 25× timing speedup.
The receipt's simple material base produces 19 nodes; the facet-based gallery
uses **22 nodes**. Timings describe this host and workload.

The pipeline uses bounded quadrature and polylines. It does not claim wet-paint
transport or an exact pixel integral. Applying a bake to a varying base does not
retroactively integrate correlations between that base and baked coverage.

## CPU preparation, editing and retained state

[ARCHITECTURE.md](../../ARCHITECTURE.md#cache-ownership) names each retained value's
owner and lifetime. One ownership primitive serves expressions, recipes, resources
and zones. A graph owns its prepared field DAG; overlapping roots extend that
preparation. One multi-output sample normalizes context once and uses one fresh
memo. There is no global inverse-matrix cache or cross-sample value memo.

The atelier paint-view cache retains one latest classification per immutable
paint, without a nested history of revisions. Compiler topology retains bounded
latest analysis; renderer resources have explicit borrowers and disposal.

Measurements: [roots60.json](roots60.json), [values60.json](values60.json),
[edits60.json](edits60.json).

| Workload | v0.59 | v0.60 candidate |
| --- | ---: | ---: |
| Prepared points, 41 overlapping outputs | 1,681 | 81 |
| Sample memo entries, those outputs | 861 | 41 |
| Warm sampling, 41 outputs | 270.88 µs | 20.48 µs |
| Same 81-node field, single output | 8.48 µs | 7.93 µs |
| Mixed RGB, color and domain image outputs | 46.21 µs | 14.43 µs |
| Trusted paint construction + normalization | 12.19 µs | 24.35 µs |
| Persistent roughness patch | 4.39 µs | 3.05 µs |
| Persistent color patch | 4.41 µs | 3.48 µs |

The overlapping-output workload is **13.23× faster**; the single-root control
is close to unchanged. Cold paint construction is more expensive because its
three colors are explicit nodes. Adapter edit results are mixed and documented
in [SHARING.md](../../SHARING.md). There is no universal speedup claim.

The roots measurement predates the version bump and retains original package
metadata and exact source fingerprints. Its measured candidate already contains
shared-root preparation. Receipts are not relabeled as another source state.

Presets share owned color expressions. Reuse shares a control; `instantiate()`
creates independent controls. The editor's independent-color action makes a new
literal sampled at the rest origin. Legacy migration preserves old independent
swatches.

## Browser verification

[browser60.json](browser60.json) records edition 060, all 16 gallery examples and
successful large-source editing. The 22-node painted carapace was reselected with
its source panel open. A literal color edit, independent-color creation, preset
replacement and a version-one graph import were each undone to the exact original
source. The preset retained all five baked resources and deposition. The guide's
native sphere/shell images loaded at 512 pixels; all 67 local asset references exist.

The browser cannot provide WebGL2. Its labeled reference image remains static;
editing and graph inspection work independently. Native execution evidence is
separate. Browser clipboard and file chooser/download delivery were not tested.
The [source inspector](../../evidence/marks60-graph.jpg) and
[marks guide](../../evidence/marks60-guide.jpg) screenshots record the completed state.

## Optimization boundary

The optional optimizer retains **24 typed surface-effect equations** and an
independent six-component verifier. `deposit` is an opaque `SurfaceAtom` for
equality saturation. Its graph remains typed/compilable, but no unproved
deposition equations or mark reordering are introduced. Normal compilation
continues sharing eligible structure and pruning unreachable work.

## Package and source release

[package-check60.json](package-check60.json) records installation of the actual
npm archive in an isolated consumer. It validates strict NodeNext/ES2022 types
with implementation TypeScript absent, audits all declarations, exercises the
renderer-free core and injected Three adapter, and checks shared module identity
across all four entries. Color conversion, mark roundtrip/bake/application and
multi-output sampling run through that installed package.

[package60.json](package60.json) records source reproducibility: extract the
complete source ZIP, rebuild, and compare every dist output byte for byte,
including all three archives. This release contains 75 runtime files and 344 source
files; all 184 rebuilt outputs match byte for byte. The portable ZIP contains the exact payload chosen
by `npm pack`. Source includes implementation, tests, tools, guides and evidence.

The package is ready for npm installation and remains unpublished to the registry.
No runtime dependency was added. The host supplies Three; Solid and Effect belong
to the atelier and are absent from the reusable core.

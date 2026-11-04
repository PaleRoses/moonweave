# Moonweave 56 verification

Release **0.56.0** completes the embedded image/mask sampling layer: explicit
pixel footprints, deterministic mip reduction, trilinear and bounded anisotropic
filtering, and zero extension for finite marks. Inscribed glaze reuses one
packed coverage/deposition/finish resource across two placements and two
specimen geometries. Graph documents remain version 1, with **six sorts and
25 operations**; the original `filled-facets/11` atlas is retained.

Baseline: **0.55.0**, source commit
`bbea70a78d3abda3e3487e0dabb32f3c67eca5ec`. Dependency maps are unchanged;
package-lock changes only the project version. No dependency or copied
third-party implementation was added for filtering. The prior Spectral.js MIT
notice remains included. The core is renderer-free; the adapter receives the
host's Three engine.

## Functional and type checks

**403 tests passed, zero failures, zero skips.** [tests.tap](tests.tap) records
the completed run. Strict application and public API type checks pass. The
installed tarball consumer passes source-free declarations and strict NodeNext.

| Boundary | Evidence |
| --- | --- |
| Compatibility | Omitted/linear policies canonicalize identically; absent/zero footprints preserve point samples exactly |
| Mip reduction | Owned/shared float32 levels, odd edge rows and columns, mean preservation, convex bounds and extended-range constants |
| Footprint mathematics | Stable principal axes, basis rotation, numeric isotropy, explicit tap quantization, singleton and rank-one footprints |
| Finite masks | Zero-border values/one-sided partials, huge exterior coordinates, virtual-level mass and subpixel attenuation |
| Calculus | Independent derivative directions and footprints; affine transport, finite-difference partials and fixed-footprint product rules |
| Repeat precision | Normalize periodic centers before offsets; exact translation regression through a `2^40` coordinate offset |
| Ownership | Shared RGB/scalar reconstruction, distinct editable resources, full mip upload, replacement and disposal |
| Portability | JSON restoration, shared resource instancing, independent local parameters and whole-expression domain binding |
| Editor | Structural filter edits, validation isolation, undo, explicit read ceilings and packed channels |
| Prior contracts | Existing pigment, coverage, zones, atlas, color, graph ownership and renderer recovery continue to pass |

The public `TexturingEngine` declaration and actual atelier capability object
now include `FloatType`, `NearestFilter` and `ClampToEdgeWrapping`. Their omission
in v55 would have prevented image materials from working with that narrow
engine object. Source and installed consumers exercise this boundary under
Three r140 and r187.

The first complete examples in [APPLICATIONS.md](../../APPLICATIONS.md) and
[FILTERING.md](../../FILTERING.md) were executed through the public API and round-trip
through graph JSON exactly. Their plans have 22 nodes / 76-read ceiling and
14 nodes / 68-read ceiling respectively. The embedded application JSON also
parses with its expected 64-read ceiling.

## Native shader verification

[native-sphere.json](native-sphere.json) and [native-shell.json](native-shell.json)
record programs assembled with Three r140/r187's own WebGL2 program assemblers
and physical shader chunks, executed through Mesa surfaceless EGL / GLES3 with
llvmpipe. All **43 source SHA256 fingerprints** in each report match the source.

| Check | Completed result |
| --- | --- |
| Compiled and linked programs | 133 per specimen |
| Rendered cases | 58 per specimen; 116 total, sphere/shell near and far |
| Prior image compatibility | All 108 v55 PNGs pixel- and byte-identical across 28,311,552 pixels |
| Resource numerical coverage | 647 contexts / 1,941 value and partial components per run |
| Maximum CPU/GPU resource error | `7.6833987e-7`, within the unchanged `3e-6` gate |
| Nonfinite shader pixels / GL errors | Zero / zero |
| Prior equivalences | Patch/fresh graph, bound/explicit frames, nested/flat finish and explicit/legacy palettes pass |

Probes cover scalar/RGB sampling, all filter/address policies, channel sharing,
odd dimensions, resource edits, affine/sheared/rank-one footprints, fractional
LODs, singleton axes, seams, masked height, huge exterior coordinates and
extended-range virtual-level scaling. Float bits are transported through RGBA8;
these are not quantized display-color comparisons. The specimen runs share
numerical contexts, so their counts are not added into independent coverage.

Actual compilation caught a reserved GLSL identifier. Native parity also
caught lost small offsets at large periodic coordinates. Both were corrected;
tolerances were not widened. [native-parity56.json](native-parity56.json) records
the prior-image comparison. New actual shader images are
[sphere](../../evidence/inscription56.png) and [shell](../../evidence/inscription-shell56.png).
Filtered and linear near/far diagnostics remain in the native validation
folders. These establish behavior on the stated software driver, not hardware
frame rate, browser rendering, animated temporal coherence or Arcane quality.

## Independent filtering quality reference

CPU/GPU agreement alone could preserve a shared error. [filtering56.json](filtering56.json)
therefore compares the sampler with the exact continuous box average of
`f(u,v) = .5 + .25 sin(2π·32u) + .2 sin(2π·8v)`. Each sinusoid's average over
the pixel parallelogram is known from two sinc factors. The actual sampler
reads a 128×128 float32 tabulation at **4,096 positions per footprint**. Error
includes tabulation, reconstruction and filtering approximations.

| Footprint | Linear RMS error | Trilinear RMS error | Anisotropic RMS error |
| --- | ---: | ---: | ---: |
| 4×4 base texels | 0.1771866 | 0.0078336 | 0.0078336 |
| Oblique, approximately 16×0.5 texels | 0.1451410 | 0.1411348 | 0.0099878 |

The square case resolves to one mip sample. For the oblique case, isotropic
mips suppress useful narrow-axis variation; eight anisotropic taps retain more
of it. These are two stated cases, not a universal bound. The
[comparison figure](../../evidence/filtering56.png) uses one 0–1 scale in all panels.
Reproduce the measurements with:

```sh
node tools/measure-filtering.mjs validation/baseline55 docs/filtering56.json
python3 tools/plot-filtering.py
```

## Representation, compatibility and work

Independent baseline/current graph, compiler and shader imports confirm all
**14 prior examples** retain identical serialized JSON, compiled nodes, program
keys and complete generated shader text. Reader filtering is structural
metadata; mipmaps are derived data, absent from serialized graphs.

| Inscribed glaze | Measured value |
| --- | ---: |
| Authored / live nodes | 37 / 37 |
| Image resources / texture bindings | 1 / 1 |
| Scalar readers / shared reconstructions | 6 / 2 |
| Resource shape | 128×64×3 |
| Authored float32 payload | 98,304 B |
| RGBA32F base upload | 131,072 B |
| RGBA32F mip pyramid | 174,768 B |
| Formatted graph JSON | 537,665 B |
| Texture-read ceiling | 132: two ×64 image ceilings plus four facet reads |
| Numeric uniform scalars | 89 |

Channels store coverage, already-covered deposition and covered polish. The
stored deposition goes directly to height because generally
`F(mask*height) ≠ F(mask)*F(height)`. Sharing storage is distinct from sharing a
reconstruction: different placements require separate samples.

Linear/trilinear/anisotropic readers have ceilings of 4/8/64 nearest texel
fetches per reconstruction. Actual work can be lower for integer LODs,
magnification, fewer taps or zero support. Pyramids upload once per owned
resource for all policies, including linear readers; this adds storage over
v55 even where shader text is unchanged. Counts exclude driver, JavaScript and
existing atlas overhead. They are not frame-time measurements.

### Production bundle

[bundle56.json](bundle56.json) uses the same compiler and gzip settings for both
revisions and verifies audited current bytes against `dist/lab.js`.

| Atelier JavaScript | 0.55.0 | 0.56.0 | Change |
| --- | ---: | ---: | ---: |
| Uncompressed | 837,526 B | 850,433 B | +12,907 B (+1.54%) |
| gzip, level 9 | 234,963 B | 239,362 B | +4,399 B (+1.87%) |

Filtering kernels, the packed application and UI explanations increase the
bundle. Existing linear graphs incur no new generated shader work. Audited
JavaScript SHA256:
`8c459e1a601477d6a47f6b4cfbc2004ad46ce1692c00535543140d52d6b254b2`.

## Browser and usability

[browser56.json](browser56.json) records **seven completed checks**: packed study
sharing, a trilinear edit with a 20-read ceiling, precise rejection of an invalid
policy while retaining the accepted graph, undo to anisotropic sampling, exact
restoration of the original saved eight-node composition, graphics diagnostics,
and both loaded guide images. [guide56.jpg](../../evidence/guide56.jpg) shows the result.

One large-textarea automation path timed out; normal paste/apply completed and
the resulting graph, costs, validation and undo were verified in the UI. No
editor defect is inferred solely from that tool timeout. The preview server was
restarted after a clean build replaced its served directory.

The cloud browser still refuses WebGL2 context creation: `GL_VENDOR = Disabled`,
`GL_RENDERER = Disabled`, `BindToCurrentSequence failed`. Its diagnostic reports
**zero browser-rendered frames**. The app labels its static reference and keeps
editing/export available. The narrow-engine bug is fixed; a material change
cannot enable browser-disabled graphics. Native render results and browser
editing checks remain separate evidence.

## Installable package and complete source

[package-check.json](package-check.json) records installation of the actual
**39-file npm tarball** into an isolated consumer. Renderer-free core imports,
shared entry-point identity, standalone declarations, strict NodeNext types,
filtered images, mip replacement, stable programs and texture disposal pass.
The tarball is installable and has not been published to the npm registry.

The runtime includes all 15 example graphs, including `examples/inscription.json`,
and the filtering/application guides. The portable ZIP contains npm's exact
payload. The complete source ZIP includes source folders, tests, tools,
documentation, research, evidence and `AGENTS.md`.

[package56.json](package56.json) records final archive membership, runtime hash
and source reproducibility. The complete source archive is extracted to an
isolated directory and rebuilt using the same pinned installed dependency tree.
Every generated output, including archives, is compared byte-for-byte. Use
`python3 tools/check-source.py` to repeat this check after building.

## Defined limits

The eight-tap anisotropic method is bounded line quadrature over mip levels,
not EWA or an exact pixel integral. Tap-count transitions are discrete. Partials
hold footprint, LOD and offsets fixed; they do not differentiate filter
selection. Zero extension uses the documented virtual scale-space, including
for odd dimensions. Image-leaf filtering does not prefilter arbitrary nonlinear
graph composition.

This layer covers embedded numeric images and planar sampling. External file
decoding, mesh UV/UDIM resources, flow/anatomy inputs and general baking/export
are separate features. Existing analytic masks and noise remain point sampled.
Height changes shading, not geometry. These boundaries do not prevent applying
the supplied graphs through the current Three adapter. [FILTERING.md](../../FILTERING.md)
specifies the complete implemented contract.

# Moonweave 59 verification

Release **0.59.0** repairs compositional expression ownership and disposed texture
references, separates the gallery registry from editor operations, and separates
compiler lowering from numerical analysis. It adds no operation, cache framework
or npm dependency. Graph-v1 retains six sorts and 25 operations; the optional
optimizer still uses its existing 24 equations.

Baseline: **0.58.0**, immutable source commit
`979c11086097a6827c9f0ee7121eb88eafcbc31d`. Historical TypeScript/sharing and native
rendering evidence is preserved in [VERIFICATION-58.md](../0.58/VERIFICATION-58.md).

## Functional and type checks

**447 tests passed, zero failures, zero skips.** [tests.tap](tests59.tap) records
this release's complete run. Strict implementation/application typechecking and
public API fixtures pass. The existing shader, field, optimizer and
resource tests in that suite remain passing.

Seven new ownership regressions cover repeated raw/named coverage inputs,
shared raw descendants, interval/chisel inputs, extracted-child reuse, naming,
caller isolation, unchanged established serialization and cycle rejection.
The constructor uses its existing temporary snapshot map to register frozen
expression descendants; the old instancing workaround was removed.

A new renderer lifetime regression exercises two materials sharing custom image
and paint resources. Disposing one clears its texture uniform slots while the
other's slots and borrower counts remain valid. The final borrower releases the
image, and system disposal releases the paint pair. Existing throwing-listener
checks now also assert that disposed owners expose null texture slots and zero
live texture bytes. Historical construction statistics remain available.

## Exact compatibility, including the actual shader assemblers

[ownership59-compatibility.json](data/ownership59-compatibility.json) records
source fingerprints, per-example hashes and the following completed comparisons:

- All **15 gallery graphs** retain exact labels, serialized documents, compiled
  nodes, output, ranges, opacity bounds, bindings, costs, diagnostics, source
  provenance, program keys and full compiled structures.
- **60 vertex/fragment program pairs** match byte for byte through the actual
  Three r140/r187 adapters and WebGLProgram assemblers, covering both local and
  attribute coordinate modes. That is 120 total assemblies across the two trees.
- **60 uniform-binding pairs** match, including matrices, vectors, image/atlas
  bytes, mip data and texture sampling settings.
- Fingerprints for 64 baseline and 66 current runtime source files remain stable
  during the comparison.

Reproduce against an installed baseline source checkout:

```sh
node tools/check-gallery.mjs /absolute/path/to/baseline validation/gallery.json
```

The recording GL object captures assembled source; this pass does not claim a
new native compile/link or rendered-pixel run. The preceding release's 153
program checks and 70 matching native renders remain historical evidence. The
current exact program/uniform comparison resolves the rendering risk of these
ownership/layout edits without conflating assembly with execution.

## Browser verification

The managed preview displays edition **059** and all 15 gallery buttons. Selecting
Cobalt & gilt loads its 45-node composition with eight reused values. Importing
the shared-height fixture displays nine authored nodes and seven live nodes;
selecting its multiply exposes both source names and both consuming ports. Two
Undo actions restore the original surface JSON exactly.

[browser59.json](browser59.json) and the
[screenshot](../../evidence/ownership59/graph.jpg) record this check. The browser cannot
obtain WebGL2, so its live 3D preview remains unavailable. Graph editing and
inspection were exercised; clipboard and browser-download delivery were not.

## Cache and design assessment

The complete ownership table is in
[ARCHITECTURE.md](../../ARCHITECTURE.md#cache-ownership). Compiler topology owns a bounded
latest-result analysis array. Immutable graph, source-node and image identities
own derived state through weak maps. Preparation maps and sample memos remain
local. Renderer resources use explicit ownership and disposal.

No global graph-history pool or manual invalidation framework was found. This is
not a heap-profile proof that every reachable object is minimal: a live topology
can retain the latest analysis input, and prepared CPU roots remain independent
when several overlapping outputs are requested. Zones preserve shared owned
inputs; raw expressions at separate zone-property boundaries are independent
snapshots. Handwritten public declarations and legacy palette swatches remain
explicit architectural seams.

This release makes no new speedup claim. The v58 timings describe v57-to-v58
scalar sharing; they are not relabeled as current measurements.

## Package and source release

The final archive checks are recorded in [package59.json](package59.json).
The check installs the actual npm tarball in an isolated consumer, validates
strict NodeNext/ES2022 declarations with source TypeScript absent, exercises the
renderer-free core and injected Three adapter, and compares npm and portable ZIP
payloads. Source verification rebuilds the complete ZIP and compares every dist
output, including all three release archives, byte for byte.

The package is prepared for npm consumption. It is not published to the npm
registry. No dependency maps changed in this release.

# Moonweave documentation

The portable program is a typed graph. The renderer, editor and optional egglog
optimizer consume that same representation. Choose the guide for the boundary
you are working on.

| Goal | Start here |
| --- | --- |
| Compose a reusable texture for a creature | [Applications](APPLICATIONS.md) |
| Learn the expression types, equations and differentiation rules | [Grammar](GRAMMAR.md) |
| Author pressure strokes, finite brushes and mark zones | [Marks](MARKS.md) |
| Convert tagged colors, mix pigments or map display gamut | [Color](COLOR.md) |
| Define image sampling, finite masks and pixel footprints | [Filtering](FILTERING.md) |
| Integrate the package with a renderer | [Texturing API](TEXTURING.md) |
| Run egglog and independently check an extracted candidate | [Optimization](OPTIMIZATION.md) |
| Understand module, graph and resource ownership | [Architecture](ARCHITECTURE.md) |
| Inspect shared execution and graph identities | [Sharing](SHARING.md) |
| Build, install and reproduce the portable archives | [Packaging](PACKAGING.md) |
| Diagnose an unavailable graphics context | [Graphics](GRAPHICS.md) |
| Review the current release's executed checks and limitations | [Verification](VERIFICATION.md) |
| Work on the implementation or run CI commands | [Contributing](../CONTRIBUTING.md) and [source map](../AGENTS.md) |

## Evidence and references

Current machine-readable results live under `evidence/<major.minor>/`, matching
the package version. Older reports and
receipts are indexed in [history/README.md](history/README.md), grouped by the
release that recorded them. Historical timings and images remain historical
observations; they are not claims about the current build.

The live atelier's reference images keep stable paths in `evidence/`. They are
explicitly labeled references when the browser cannot create a graphics context.

[COLOR-STUDY.md](COLOR-STUDY.md) and [RESEARCH.md](RESEARCH.md) collect the
rendering and authoring research. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)
records adapted code, data and included notices.

- [Mesh-guided stroke flow](FLOW-GUIDES.md): fold-aligned UV direction maps, curved pressure paths, and form-aware AO pigment.

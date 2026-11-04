# Third-party sources and notices

Moonweave's own package is currently `UNLICENSED` and private. This document
records the upstream material and dependencies used by the implementation;
their licenses do not set a license for Moonweave's own code.

## Adapted implementation and data

| Upstream | Use in Moonweave | Included notice |
| --- | --- | --- |
| [Spectral.js](https://github.com/rvanwijnen/spectral.js), Ronald van Wijnen | Spectral basis data and pigment conversion adapted in `src/color/pigment.mts` and `spectral-data.mjs` | [SPECTRAL-LICENSE.txt](src/color/SPECTRAL-LICENSE.txt), MIT |
| [CSS Color 4](https://www.w3.org/TR/2026/CRD-css-color-4-20261103/), W3C | D65 conversion reference material and the local-MINDE gamut-mapping algorithm in `src/color/management.mts` | [COLOR-LICENSE.txt](src/color/COLOR-LICENSE.txt), W3C Software and Document License 2023; includes modification notes |
| [Three.js](https://github.com/mrdoob/three.js) | Injected renderer API, shader integration, reference engine chunks and atelier scene rendering | [THREE-LICENSE.txt](THREE-LICENSE.txt), MIT |

The build copies all three notices into the runtime tarball and portable ZIP.
The pure surface runtime does not bundle the Three engine. The color-management
implementation does not copy Color.js source code; that project's documentation
and tests informed comparison and review.

## Installed dependencies

The exact JavaScript development dependencies are recorded in `package-lock.json`.
They include TypeScript, esbuild, Babel, Solid and Effect. Their installed packages
retain their own notices, and bundled atelier dependencies retain the legal
comments emitted by the build. These build/editor dependencies are not bundled
into the pure library entry points.

The optional optimizer uses [egglog-python](https://github.com/egraphs-good/egglog-python)
through the version pinned in `tools/egglog/requirements.txt`. It is installed
separately; the source archive includes Moonweave's bridge, not a vendored copy
of the egglog engine. Its MIT notice remains with the installed dependency.

Repository and packaging conventions were checked against the official
[npm package documentation](https://docs.npmjs.com/cli/configuring-npm/package-json/),
[TypeScript library guidance](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html),
[GitHub contribution guidance](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors),
and [Reproducible Builds archive guidance](https://reproducible-builds.org/docs/archives/).
These are design references; their build systems are not copied into Moonweave.

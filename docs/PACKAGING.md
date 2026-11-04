# Package structure and verification

Moonweave develops one library and one atelier in a single repository. The public API remains four ESM entry points. Source folders describe responsibility; package exports describe the supported consumer boundary.

## Source and output

| Location | Owns |
| --- | --- |
| `src/core/` | Operation signature, graph construction, compilation, CPU interpretation and recipe values |
| `src/paint/` | Deterministic atlas data, mark programs, stroke expansion, spatial baking and graph application |
| `src/three/` | Shader generation, uniforms, textures, materials and rest-coordinate attributes |
| `src/{index,core,three,optimize}.mjs` | The four public runtime barrels |
| `src/*/public-types.mts` | Pure type reexports; contracts live beside checked implementations |
| `lab/` | The Solid atelier and its Effect-owned browser operations |
| `examples/` | Runnable source workflows; distinct from the generated graph JSON in runtime downloads |
| `tests/consumer/` | Fixtures executed outside the repository against an installed tarball |
| `tools/` | Build, package checks, measurements and driver validation |
| `build/package/` | Clean, generated npm package staging directory |
| `dist/` | The built website and downloads |

The root `package.json` is a private development manifest. Its exports resolve source files so repository tests exercise the authored modules. `npm run build` creates the separate release manifest in `build/package/`, whose exports resolve compiled JavaScript and standalone declarations. Run the release workflow below to obtain the distributable; `npm pack` at the repository root packs the development manifest.

The runtime entries share chunks. This preserves graph identities, normalized values and compiler caches when a host authors through `/core` and renders through `/three`. The core and optimization bundle audits reject modules from `src/three/`. The optimization entry contains pure term interchange and verification; the optional Python engine, runner and simulation tools remain in the complete source archive. The adapter receives engine capabilities; it does not bundle Three, Solid or Effect into the library.

## Standalone types

All public function signatures come from their strict TypeScript implementations.
Semantic graph data types derive from the operation signature or live in the
small graph data owner. Public type barrels contain only type reexports; there
are no handwritten `.d.mts` files to maintain in parallel with runtime code.

`tsconfig.declarations.json` emits the four public entry points and their owning
dependency declarations. The build rewrites relative `.mts` specifiers to `.mjs`
and retains only the public declaration dependency closure. Recursive constructor
return types are explicitly checked at their implementations so TypeScript does
not expand recursive inference into an elided `any` in the declaration output.

| Consumer entry | Runtime target | Declaration target |
| --- | --- | --- |
| `@moonweave/surfaces` | `moonweave.mjs` | `types/index.d.mts` |
| `@moonweave/surfaces/core` | `moonweave-core.mjs` | `types/core.d.mts` |
| `@moonweave/surfaces/three` | `moonweave-three.mjs` | `types/three.d.mts` |
| `@moonweave/surfaces/optimize` | `moonweave-optimize.mjs` | `types/optimize.d.mts` |

The `types` export condition comes first, followed by the ESM `import` and `default` targets. Internal module paths are not exported. A consumer therefore receives a deliberate API and declaration closure, without raw implementation TypeScript or a requirement to enable JavaScript inference.

[Node's package guidance](https://nodejs.org/api/packages.html) defines conditional-export ordering and public subpath encapsulation. [TypeScript's library guidance](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options) recommends strict Node-compatible module checking because bundler-only resolution can accept imports that fail for Node consumers. TypeScript documents the `.mts` → `.d.mts` declaration correspondence in its [4.7 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-7).

## Actual npm packing

The staged manifest uses an explicit `files` allowlist: the four runtime entries, shared chunks, declarations, example graphs, selected documentation, build manifest and third-party notice. npm includes its mandatory manifest and README files. Raw source, the atelier, tools, tests and historical verification artifacts stay in the complete source archive.

`tools/package.py` invokes `npm pack --json --ignore-scripts --offline` in `build/package/`. npm creates the `.tgz`; Python reads the exact packed bytes to create the matching portable ZIP. Both downloads therefore contain the same files and content. Python separately creates the source ZIP from the maintained source folders and build configuration.

This follows npm's [documented files allowlist](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) and [packing command](https://docs.npmjs.com/cli/v11/commands/npm-pack/). Mature libraries such as [Three](https://github.com/mrdoob/three.js/blob/dev/package.json) and [Effect](https://github.com/Effect-TS/effect/blob/main/packages/effect/package.json) likewise declare distribution membership and public entry points explicitly. Their full build systems are not dependencies of this project.

## Portable source boundary

The source ZIP contains one `moonweave/` root with the same `src/`, `lab/`,
`examples/`, `tests/`, `tools/` and `docs/` layout as the repository. It includes the lockfile,
TypeScript configuration, source map, contributor guide, third-party notices,
`.gitignore` and the authored `.github/workflows/check.yml` workflow.

`tools/package.py` owns a single source-membership policy, shared with the source
verifier. It selects maintained source/document/image extensions and an explicit
list of root configuration files. Directory walking prunes dependency installs,
local environments, caches and generated trees before visiting their contents.
Selected files and directories must be real owned files; symlinks cannot pull
external content into the archive. Site configuration and Git metadata are
outside the policy.

ZIP entries have stable ordering, timestamps, permissions and platform metadata.
This follows the [Reproducible Builds archive guidance](https://reproducible-builds.org/docs/archives/).
The archive is self-contained source: its membership does not depend on a Git
checkout, and the extracted tree can generate the same source ZIP again.

Current guides live directly in `docs/`. Current release receipts use
`docs/evidence/<major.minor>/`; archived reports and raw measurements use
`docs/history/<major.minor>/`. Historical JSON and TAP contents are preserved.
The source documentation index and history index provide navigation. Runtime
guides identify evidence that requires the full source archive, so their lean
package does not depend on a private website or absent receipt links.

The included GitHub workflow checks the source, generated declarations, actual
installed package, source archive and separately installed pinned egglog engine.
Official actions are pinned to the inspected release commits. The workflow has
only `contents: read`, retains no checkout credential and contains no publishing
step. Its local commands are documented in the source archive's `CONTRIBUTING.md`;
supplying the workflow does not imply a GitHub run has occurred.

## Reproduce and check

Source tooling requires Node.js 24 or newer, npm and Python 3. Install the pinned development dependencies first:

```sh
npm ci
npm test
npm run typecheck
npm run test:types
python3 tools/test_package.py
npm run build
npm run check:package
python3 tools/check-source.py validation/source-package.json
```

`check:package` uses a fresh temporary consumer outside the checkout and installs the actual `.tgz` through npm. It performs these checks:

1. Compare installed membership and bytes with npm's allowlisted stage inventory; verify the four export targets exist and no source implementation leaked into the package.
2. With Three, Solid and Effect absent, import all runtime entry points, exercise graph values and serialization, verify shared function and plan identities, and typecheck a core consumer using only the ES2022 library.
3. Copy the checkout's pinned Three runtime, declarations and their installed dependency closure into the isolated consumer, then exercise material creation, stable uniforms and program identity across a value patch, coordinate binding and borrowed atlas disposal.
4. Run the existing public API type fixtures against the installed package using strict NodeNext resolution, `allowJs: false`, `allowImportingTsExtensions: false` and `skipLibCheck: false`.

The host-peer phase preserves installed dependency folders and copies their files; it creates no symlinks back to the checkout and requires no npm registry metadata or cached downloads. Moonweave itself is installed by npm from its actual tarball, offline and with lifecycle scripts disabled. The temporary project is removed after the check. The tool prints a concise receipt with the verified version and file count.

The generated package retains `private: true`. Local tarball installation works; public npm registry publication is a separate release action.

## Declaration and source checks

The actual tarball audit parses every shipped declaration and rejects `any`
types. It then checks source-free NodeNext/ES2022 consumers with
`skipLibCheck: false`, including marks, color management, multi-output sampling
and the injected renderer. Runtime-only GLSL/paint kernels need no unrelated
declaration payload. The source tree runs on Node 24 type stripping; the runtime
package contains bundled JavaScript and standalone generated declarations.

`tools/check-source.py` first verifies exact source membership and bytes against
the maintained checkout, including the workflow and notices. It rejects duplicate
or unsupported archive paths and checks regular-file metadata before extraction.
It then rebuilds with the installed pinned dependency tree, compares every
generated distribution byte, and compares the runtime ZIP's payload with npm's
tarball. This checks the actual delivered source, without claiming a second
network dependency installation. See the current release receipt in
`docs/VERIFICATION.md` in the source archive.

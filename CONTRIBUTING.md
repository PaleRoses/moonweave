# Working on Moonweave

Start with [the source map](AGENTS.md), then [the documentation index](docs/README.md).
The source folders describe responsibility; the four package exports define the
supported API. Keep reusable calculations in `src/` and editor behavior in `lab/`.

## Local development

Use Node.js 24 or later, npm, and Python 3. Source TypeScript runs through Node's
type stripping. Install the exact JavaScript dependency tree from the lockfile:

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

The build produces the atelier, a compiled runtime tarball, an equivalent runtime
ZIP, and a portable source ZIP in `dist/downloads/`. The source archive rebuild
uses the installed dependency tree and compares every generated output byte for
byte. It does not perform a second network installation.

To inspect the extracted project on your own machine, serve the built atelier:

```sh
python3 -m http.server 4173 --directory dist
```

Open `http://localhost:4173`. A WebGL2-capable browser is needed for the live
preview; the graph editor can run without it. [GRAPHICS.md](docs/GRAPHICS.md)
explains graphics diagnostics. Managed Sites workspaces use their own preview
workflow instead of this local-development command.

## Optional egglog development

The application and runtime package do not require Python egglog. To work on the
offline optimizer, use Python 3.12 or later and its pinned dependency:

```sh
python3 -m venv .venv-egglog
.venv-egglog/bin/python -m pip install -r tools/egglog/requirements.txt
.venv-egglog/bin/python tools/egglog/test_run.py
MOONWEAVE_EGGLOG_PYTHON=.venv-egglog/bin/python npm test
```

The CLI, structured interchange, extraction policy and executable examples are
documented in [OPTIMIZATION.md](docs/OPTIMIZATION.md). Keep typed equations in
their TypeScript owner; the Python bridge generates its language from that
manifest. Candidate acceptance belongs to Moonweave's independent verifier and
compiled DAG cost gate.

## Make a focused change

Preserve graph sharing and the distinction between structural literals and
editable values. Floating-point grouping is authored structure. An optimization
must retain the observations it claims to preserve; an engine's own cost or
equivalence result is not that check.

For a new operation, update its signature, constructor, CPU interpretation and
GPU lowering together. Public declarations are generated from the owning
implementations. For ownership changes, exercise raw input, reused owned input,
persistent edits and serialization. For image/filtering changes, verify values
and derivatives at boundaries as well as interior samples.

Run focused tests while editing, then the relevant release gates. Include a
minimal graph or mark program with a bug report. Performance changes should
identify the workload, baseline, deterministic work counts, timings and control
cases. Keep paired runs separate from compilation and competing measurements.
Document limitations alongside results.

## Documentation and evidence

Maintained guides live directly under `docs/`. The current release report is
`docs/VERIFICATION.md`; its machine-readable receipts belong in
`docs/evidence/<major.minor>/`. Historical reports and receipts live under
`docs/history/<major.minor>/` and retain their original filenames and observations.
Published evidence is preserved rather than relabeled as a fresh measurement.

Measurement tools accept explicit output paths. Their default paths use the
current package edition through `tools/evidence-path.mjs`. Put scratch data and
temporary validation builds under ignored `validation/`.

## Continuous integration and publication

[The GitHub workflow](.github/workflows/check.yml) runs the source, type, egglog,
archive and installed-package checks above with Node 24 and Python 3.12. It uses
official actions pinned to specific commits and only `contents: read`. It has no
publishing step. The workflow is supplied for the future GitHub repository;
local verification does not imply that GitHub has executed it.

Native EGL/GLES3 validation is a separate optional check because it requires
Mesa and the driver dependencies described in [VERIFICATION.md](docs/VERIFICATION.md).
Browser interaction and native shader execution provide different evidence.

Moonweave's own code remains `UNLICENSED`, and both manifests remain private.
The source ZIP carries no Site identity, credentials, Git metadata, dependency
installations or generated distribution. Choosing a project license and
publishing to GitHub or npm are separate release decisions. Preserve the
upstream notices listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

# Development tools

Run these commands from the repository root after `npm ci`. The implementation
and atelier do not import these tools. Node 24 runs the checked source modules;
Python handles archive verification, the optional egglog engine, and native
driver checks.

| Work | Command / owner |
| --- | --- |
| Build the atelier and all three archives | `npm run build` → `build.mjs`, `package.py` |
| Verify the actual installed npm tarball | `npm run check:package` → `check-package.mjs` |
| Verify the portable source boundary | `python3 tools/test_package.py` |
| Rebuild the source ZIP and compare every output | `python3 tools/check-source.py validation/source-package.json` |
| Optimize a graph through real egglog | `npm run optimize -- input.json output.json --python .venv-egglog/bin/python` |
| Check the pinned Python bridge | `.venv-egglog/bin/python tools/egglog/test_run.py` |
| Observe graph values and edit revisions | `compare-graphs.mjs`; see [optimization](../docs/OPTIMIZATION.md) |
| Compare gallery graphs, plans and assembled shader source | `check-gallery.mjs <baseline-directory> [report.json]` |
| Execute the generated shader programs through native GLES3 | `validate-texturing-gpu.py <output-directory>` |
| Compare the built atelier bundle | `audit-bundle.mjs <baseline-directory> <report.json>` |

## Measurements

`benchmark-*.mjs` and `measure-*.mjs` are executable experiments with explicit
workloads. Most paired tools take a baseline source directory and optional
receipt path. Tools requiring a particular baseline explain it in their usage
message; historical scripts are not interchangeable benchmark specifications.

Default release receipts use `evidencePath(filename)` from `evidence-path.mjs`,
which derives `docs/evidence/<major.minor>/` from `package.json`. Explicit output
arguments always override that destination. Temporary grids, render images,
subprocess artifacts and extracted builds belong under ignored `validation/`.

Preserve raw measurements with the method, source versions and fingerprints.
Compare deterministic work counts before interpreting timings, and run paired
timing batches without concurrent builds or competing benchmarks. Old results
remain in [the evidence archive](../docs/history/README.md); current measurements
are linked from [VERIFICATION.md](../docs/VERIFICATION.md).

## Source archive policy

`package.py` owns source membership and deterministic ZIP metadata. The source
policy is shared by packing and `check-source.py`; it is independent of Git so
an extracted archive can rebuild itself. The npm archive is made by `npm pack`
from `build/package/`, and its exact file bytes become the portable runtime ZIP.

See [PACKAGING.md](../docs/PACKAGING.md) for consumer boundaries and reproduction.

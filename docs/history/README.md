# Release evidence archive

The maintained guides are in [the documentation index](../README.md). The
current executed report is [VERIFICATION.md](../VERIFICATION.md).

These folders retain earlier release reports, raw measurements, complete TAP
logs where available, native-driver reports and optimizer examples. Filenames
and JSON/TAP contents are preserved. Relative links in moved Markdown reports
have been repaired; their historical observations have not been relabeled.

| Release | Report or first receipt | Archived files |
| --- | --- | ---: |
| 0.61 | [VERIFICATION.md](0.61/VERIFICATION.md) | 13 |
| 0.60 | [VERIFICATION-60.md](0.60/VERIFICATION-60.md) | 12 |
| 0.59 | [VERIFICATION-59.md](0.59/VERIFICATION-59.md) | 5 |
| 0.58 | [VERIFICATION-58.md](0.58/VERIFICATION-58.md) | 13 |
| 0.57 | [VERIFICATION-57.md](0.57/VERIFICATION-57.md) | 14 |
| 0.56 | [VERIFICATION-56.md](0.56/VERIFICATION-56.md) | 10 |
| 0.55 | [applications55.json](0.55/applications55.json) | 5 |
| 0.54 | [browser54.json](0.54/browser54.json) | 5 |
| 0.53 | [browser53.json](0.53/browser53.json) | 5 |
| 0.52 | [browser52.json](0.52/browser52.json) | 5 |
| 0.51 | [browser51.json](0.51/browser51.json) | 5 |
| 0.50 | [bundle50.json](0.50/bundle50.json) | 4 |
| 0.49 | [bundle49.json](0.49/bundle49.json) | 4 |
| 0.48 | [bundle48.json](0.48/bundle48.json) | 4 |
| 0.47 | [performance47.json](0.47/performance47.json) | 1 |
| 0.45 | [benchmark.json](0.45/benchmark.json) | 2 |

Folder names identify the release that recorded or published the evidence.
Some measurements were taken before a package-version bump; their embedded
versions and source hashes remain unchanged. For unnumbered files, the original
Git commit identifies the release. The unnumbered native reports belong to
0.56; the original `benchmark.json` and `performance.json` belong to 0.45.

The 0.56 TAP log was recovered byte-for-byte from its original source commit
`84fb8ca1406085fb42f6ad666e31fb91e16addf7`. Later saved TAP logs and raw JSON
receipts are moved without changing their contents. Paths embedded inside those
receipts describe the original run, and may identify historical local directories.

Live guide illustrations and explicitly labeled fallback images retain stable
paths under `docs/evidence/`. New measurements use `docs/evidence/<major.minor>/`
with readable filenames; a new release never overwrites an archived result.

"""Rebuild the source archive and compare all artifacts against the current build."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import zipfile
from package import SOURCE_FILES, source_files, source_member

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text())['version']
edition = version.split('.')[1]
destination = root / f'validation/rebuilt{edition}'
source = root / f'dist/downloads/moonweave-{version}-source.zip'
if destination.exists():
    shutil.rmtree(destination)
destination.mkdir(parents=True)
with zipfile.ZipFile(source) as archive:
    names = archive.namelist()
    required = [f'moonweave/{name}' for name in SOURCE_FILES] + ['moonweave/docs/APPLICATIONS.md',
                'moonweave/docs/FILTERING.md', 'moonweave/tools/check-source.py',
                'moonweave/docs/OPTIMIZATION.md', 'moonweave/src/core/types.mts',
                'moonweave/docs/SHARING.md', 'moonweave/src/core/graph.mts',
                'moonweave/src/core/compile.mts', 'moonweave/src/core/evaluate.mts',
                'moonweave/src/core/intern.mts', 'moonweave/src/core/inspect.mts',
                'moonweave/src/core/effects.mts', 'moonweave/src/core/optimize.mts',
                'moonweave/tools/egglog/run.py', 'moonweave/tools/egglog/requirements.txt',
                'moonweave/examples/optimize-effects.mjs',
                'moonweave/tools/compare-graphs.mjs',
                'moonweave/src/color/SPECTRAL-LICENSE.txt',
                'moonweave/src/color/COLOR-LICENSE.txt',
                'moonweave/docs/README.md']
    expected_source = {f'moonweave/{name}': path for name, path in source_files(root)}
    assert len(names) == len(set(names)), 'Source archive has duplicate members'
    assert all(name.startswith('moonweave/') and source_member(name[len('moonweave/'):])
               for name in names), 'Source archive contains an unsupported path'
    assert set(names) == expected_source.keys(), {
        'missing': sorted(expected_source.keys() - set(names)),
        'unexpected': sorted(set(names) - expected_source.keys())}
    assert all(name in names for name in required)
    for entry in archive.infolist():
        assert not entry.is_dir() and (entry.external_attr >> 16) == 0o644, entry.filename
        assert archive.read(entry) == expected_source[entry.filename].read_bytes(), entry.filename
    archive.extractall(destination)
checkout = destination / 'moonweave'
(checkout / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
with (root / f'validation/rebuilt{edition}.log').open('w') as log:
    subprocess.run(['node', 'tools/build.mjs'], cwd=checkout,
                   stdout=log, stderr=subprocess.STDOUT, check=True)


def files(folder):
    return {path.relative_to(folder).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in folder.rglob('*') if path.is_file()}


original = files(root / 'dist')
rebuilt = files(checkout / 'dist')
assert original.keys() == rebuilt.keys(), {
    'missing': sorted(original.keys() - rebuilt.keys()),
    'added': sorted(rebuilt.keys() - original.keys())}
changed = [name for name in original if original[name] != rebuilt[name]]
assert not changed, changed
tarball = root / f'dist/downloads/moonweave-surfaces-{version}.tgz'
with tarfile.open(tarball) as archive:
    npm = {entry.name.removeprefix('package/'): archive.extractfile(entry).read()
           for entry in archive if entry.isfile()}
with zipfile.ZipFile(root / f'dist/downloads/moonweave-surfaces-{version}.zip') as archive:
    portable = {entry.filename.removeprefix('moonweave-surfaces/'): archive.read(entry)
                for entry in archive.infolist() if not entry.is_dir()}
assert npm == portable
receipt = {
    'version': version,
    'runtimeFiles': len(npm),
    'runtimeTarball': tarball.name,
    'runtimeTarballSHA256': hashlib.sha256(tarball.read_bytes()).hexdigest(),
    'portableZipMatchesNpmPayload': True,
    'sourceArchive': source.name,
    'sourceFiles': len(names),
    'sourcePolicy': {
        'exactMaintainedSourceMembership': True,
        'sourceBytesMatchCheckout': True,
        'githubWorkflowIncluded': True,
        'siteConfigurationExcluded': True,
        'dependenciesAndGeneratedOutputsExcluded': True,
        'symlinksExcluded': True,
    },
    'sourceRebuild': {
        'method': 'Extract complete source ZIP into an isolated directory, use the pinned installed dependency tree, run tools/build.mjs, compare every dist output including all three archives byte-for-byte.',
        'expectedOutputs': len(original),
        'allOutputsByteIdentical': True,
    },
}
release = '.'.join(version.split('.')[:2])
target = Path(sys.argv[1]) if len(sys.argv) > 1 else root / f'docs/evidence/{release}/package.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2))

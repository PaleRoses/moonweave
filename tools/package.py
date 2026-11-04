#!/usr/bin/env python3
"""Pack the release with npm; ZIP the identical payload and archive the source."""
from pathlib import Path, PurePosixPath
import json
import os
import subprocess
import sys
import tarfile
import zipfile

SOURCE_DIRECTORIES = ('src', 'lab', 'examples', 'tools', 'tests', 'docs')
SOURCE_FILES = (
    'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md',
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.public.json',
    'tsconfig.declarations.json', 'THREE-LICENSE.txt', '.gitignore',
    '.github/workflows/check.yml',
)
SOURCE_EXTENSIONS = frozenset({
    '.mjs', '.mts', '.js', '.jsx', '.ts', '.tsx', '.css', '.html', '.json',
    '.py', '.txt', '.md', '.tap', '.png', '.jpg', '.jpeg', '.svg', '.webp',
})
GENERATED_DIRECTORIES = frozenset({'node_modules', 'dist', 'build', 'validation', '__pycache__'})
STAMP = (2026, 11, 3, 0, 0, 0)


def source_member(name):
    """One portable source policy, shared by packing and archive verification."""
    path = PurePosixPath(name)
    if path.as_posix() != name or path.is_absolute() or '\\' in name or '..' in path.parts:
        return False
    if name in SOURCE_FILES:
        return True
    return (len(path.parts) > 1 and path.parts[0] in SOURCE_DIRECTORIES
            and path.suffix in SOURCE_EXTENSIONS
            and all(not part.startswith('.') and part not in GENERATED_DIRECTORIES
                    for part in path.parts))


def source_files(root):
    """Visit authored files only; prune dependency and generated trees before walking."""
    selected = []
    for directory in SOURCE_DIRECTORIES:
        base = root / directory
        if base.is_symlink():
            raise ValueError(f'Source directories must be owned files, not symlinks: {directory}')
        for folder, directories, filenames in os.walk(base):
            directories[:] = sorted(name for name in directories
                                    if not name.startswith('.') and name not in GENERATED_DIRECTORIES)
            for name in directories:
                if (Path(folder) / name).is_symlink():
                    raise ValueError(f'Source directory symlink is not portable: {Path(folder) / name}')
            for name in filenames:
                path = Path(folder) / name
                relative = path.relative_to(root).as_posix()
                if source_member(relative):
                    if path.is_symlink():
                        raise ValueError(f'Source file symlink is not portable: {relative}')
                    selected.append((relative, path))
    for name in SOURCE_FILES:
        path = root / name
        parts = PurePosixPath(name).parts
        if any(root.joinpath(*parts[:end]).is_symlink() for end in range(1, len(parts) + 1)) or not path.is_file():
            raise ValueError(f'Required source file is missing or not an owned file: {name}')
        selected.append((name, path))
    return sorted(selected)


def zip_files(destination, files, prefix):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative, content in sorted(files):
            entry = zipfile.ZipInfo(prefix + relative, date_time=STAMP)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, content)


def pack(root, stage, version):
    out = root / 'dist' / 'downloads'
    packed, = json.loads(subprocess.check_output([
        'npm', 'pack', '--json', '--ignore-scripts', '--offline',
        '--pack-destination', str(out),
    ], cwd=stage, text=True))
    # Copy npm's exact bytes so the two runtime payloads cannot diverge.
    with tarfile.open(out / packed['filename'], 'r:gz') as archive:
        package_files = [(entry.name.removeprefix('package/'), archive.extractfile(entry).read())
                         for entry in archive if entry.isfile()]
    assert sorted(name for name, _ in package_files) == sorted(item['path'] for item in packed['files'])
    zip_files(out / f'moonweave-surfaces-{version}.zip', package_files, 'moonweave-surfaces/')
    zip_files(out / f'moonweave-{version}-source.zip',
              [(name, path.read_bytes()) for name, path in source_files(root)], 'moonweave/')
    print(json.dumps({p.name: p.stat().st_size for p in sorted(out.iterdir()) if p.is_file()}))


if __name__ == '__main__':
    pack(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])

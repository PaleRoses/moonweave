"""Portable source boundary and deterministic archive checks; no npm/network needed."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import zipfile

from package import SOURCE_DIRECTORIES, SOURCE_FILES, STAMP, source_files, source_member, zip_files


class SourceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for directory in SOURCE_DIRECTORIES:
            (self.root / directory).mkdir()
        for name in SOURCE_FILES:
            self.write(name)

    def write(self, name, content='fixture'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def test_source_selection_excludes_local_and_generated_state(self):
        included = ['src/core/graph.mts', 'examples/optimize-effects.mjs',
                    'tests/fixture.json', 'docs/evidence/0.62/report.json']
        excluded = ['.openai/hosting.json', '.git/config', '.env',
                    'tools/.venv-egglog/lib/dependency.py', 'tools/node_modules/vendor/index.mjs',
                    'tools/__pycache__/package.pyc', 'src/.env', 'src/.secret.json',
                    'docs/archive.zip', 'docs/build/output.json', 'lab/validation/record.json']
        for name in included + excluded:
            self.write(name)
        selected = [name for name, _ in source_files(self.root)]
        self.assertEqual(selected, sorted([*SOURCE_FILES, *included]))

    def test_source_symlinks_are_rejected_without_copying_the_target(self):
        target = self.write('outside.json', 'outside source')
        link = self.root / 'src/borrowed.json'
        link.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            source_files(self.root)
        link.unlink()
        (self.root / 'src/borrowed').symlink_to(self.root / 'tests', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            source_files(self.root)

    def test_members_require_canonical_relative_allowlisted_paths(self):
        for name in ['src/graph.mts', '.gitignore', '.github/workflows/check.yml']:
            self.assertTrue(source_member(name), name)
        for name in ['../src/graph.mts', '/src/graph.mts', 'src/../tools/data.json',
                     'src//graph.mts', 'src\\graph.mts', './src/graph.mts',
                     '.github/workflows/publish.yml', '.openai/hosting.json',
                     'node_modules/dep/index.mjs', 'src/.credentials.json']:
            self.assertFalse(source_member(name), name)

    def test_zip_content_and_metadata_are_stable_across_input_order(self):
        files = [('src/b.mts', b'export const b = 2;'), ('README.md', b'Moonweave')]
        first, second = self.root / 'first.zip', self.root / 'second.zip'
        zip_files(first, files, 'moonweave/')
        zip_files(second, list(reversed(files)), 'moonweave/')
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with zipfile.ZipFile(first) as archive:
            self.assertEqual(archive.namelist(), ['moonweave/README.md', 'moonweave/src/b.mts'])
            for entry in archive.infolist():
                self.assertEqual(entry.date_time, STAMP)
                self.assertEqual(entry.create_system, 3)
                self.assertEqual(entry.external_attr >> 16, 0o644)

    def test_explicit_workflow_must_not_be_borrowed_from_a_symlinked_directory(self):
        (self.root / '.github').rename(self.root / 'borrowed-github')
        (self.root / '.github').symlink_to(self.root / 'borrowed-github', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'owned file'):
            source_files(self.root)


if __name__ == '__main__':
    unittest.main()

"""Exercise the actual CI command and pre-commit hook in disposable repositories."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class PublicationGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nl-publication-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        (self.root / 'scripts').mkdir()
        (self.root / '.githooks').mkdir()
        shutil.copy2(ROOT / 'scripts/check-upload-links.py', self.root / 'scripts')
        shutil.copy2(ROOT / '.githooks/pre-commit', self.root / '.githooks')
        self.git('add', '.')
        self.git('commit', '-qm', 'clean baseline')

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.PIPE)

    def command(self, *args):
        return subprocess.run(args, cwd=self.root, capture_output=True, text=True)

    def samples(self):
        key = 'Q' * 12 + 'z' * 36
        return [key, 'https://' + 'fixture.' + 'ufs' + '.sh/f/' + key,
                'https://' + 'utfs' + '.io/f/' + key,
                'https://' + 'upload' + 'thing.com/f/' + key]

    def test_ci_command_rejects_tracked_leaks_without_logging_values(self):
        for content in self.samples():
            with self.subTest(content_kind=len(content)):
                (self.root / 'leak.md').write_text(content)
                self.git('add', 'leak.md')
                self.git('commit', '-qm', 'synthetic fixture')
                result = self.command('python3', 'scripts/check-upload-links.py')
                self.assertEqual(result.returncode, 1)
                self.assertIn('leak.md:1:', result.stderr)
                self.assertNotIn(content, result.stdout + result.stderr)

    def test_hook_blocks_commit_even_when_working_tree_was_cleaned(self):
        self.git('config', 'core.hooksPath', '.githooks')
        head = self.git('rev-parse', 'HEAD')
        for content in self.samples():
            (self.root / 'leak.md').write_text(content)
            self.git('add', 'leak.md')
            (self.root / 'leak.md').write_text('clean working tree; staged blob still leaks')
            result = self.command('git', 'commit', '-qm', 'must be blocked')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('leak.md:1:', result.stderr)
            self.assertNotIn(content, result.stdout + result.stderr)
            self.assertEqual(self.git('rev-parse', 'HEAD'), head)

    def test_clean_commit_and_ci_accept_longer_hashes_and_ignored_local_files(self):
        self.git('config', 'core.hooksPath', '.githooks')
        (self.root / '.gitignore').write_text('local/\n')
        (self.root / 'local').mkdir()
        (self.root / 'local/private.json').write_text(self.samples()[1])
        integrity = 'sha512-' + 'B' * 41 + '//' + 'dependency-integrity'
        (self.root / 'clean.md').write_text('a' * 64 + '\nnormal text\n' + integrity)
        self.git('add', '.gitignore', 'clean.md')
        self.assertEqual(self.command('git', 'commit', '-qm', 'clean').returncode, 0)
        self.assertEqual(self.command('python3', 'scripts/check-upload-links.py').returncode, 0)


if __name__ == '__main__':
    unittest.main()

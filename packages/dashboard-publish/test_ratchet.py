import json
import tempfile
from pathlib import Path
import unittest
from gate import manifest_only
from admission import Refusal
from ratchet import check


class WiringTest(unittest.TestCase):
    def test_put_must_have_executable_adjacent_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            for suffix, gate, put in [('py', 'assert_publish_admission(envelope)', 'request = Request(url, method="PUT")'),
                                      ('mjs', 'assertPublishAdmission(envelope);', 'const r = fetch(url, {method:"PUT"});')]:
                path = Path(directory) / ('deploy.' + suffix)
                for source, refused in [(put, True), (('#' if suffix == 'py' else '//') + gate + '\n' + put, True),
                                        (put + '\n' + gate, True), (gate + '\n' + put, False)]:
                    path.write_text(source)
                    self.assertEqual(bool(check([path])), refused)

    def test_archive_cannot_change_shells(self):
        baseline = {'clientBundle': 'unchanged', 'artifact': {'source': {'files': [
            {'path': 'manifest.json', 'hash': 'old'}, {'path': 'shells.ts', 'hash': 'shell'}]}, 'server': {}, 'database': {}}}
        candidate = json.loads(json.dumps(baseline))
        candidate['artifact']['source']['files'][0]['hash'] = 'new'
        manifest_only(candidate, baseline, 'manifest.json')
        candidate['artifact']['source']['files'][1]['hash'] = 'changed'
        with self.assertRaises(Refusal): manifest_only(candidate, baseline, 'manifest.json')

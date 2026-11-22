"""The invariant: an audio handoff of the pre-kind shape is admitted or refused exactly as master's gate does.

The golden was produced by master's admission.py (admission_golden.py cf4dedb2). This checkout's admit() runs
the same corpus WITHOUT the media argument, so the comparison holds on master and on this branch alike.
"""
import json
import tempfile
import unittest
from pathlib import Path

import admission
from admission_golden import ROOT, run

GOLDEN = json.loads((ROOT / 'fixtures/admission-golden.json').read_text())
# The deliberate tightenings for existing pages: master admitted each; the host refused or broke each at run time.
TIGHTENED = {
    # The host's upload manifest takes only assets/<name>.<kind ext> (server/dashboard-media-runtime.ts:8, "Invalid UploadThing entry").
    'png-row-without-kind': 'HANDOFF_SCHEMA',
    'clip-row-outside-assets': 'HANDOFF_SCHEMA',
    # The host refuses a duplicate dashboard/file entry ("Duplicate UploadThing entry").
    'duplicate-clip-name': 'MEDIA_KIND',
    # New limits; the largest real clip is 662 KB and the largest real page 124 clips.
    'clip-over-five-mib': 'MEDIA_TOO_LARGE',
    'two-hundred-and-one-clips': 'MEDIA_COUNT',
    # A clip named anywhere but an <audio src>, or an assets/ path the manifest lacks, resolves on the app origin and 404s.
    'clip-linked-outside-audio': 'MEDIA_REFERENCE',
    'assets-path-not-in-manifest': 'MEDIA_REFERENCE',
}


class GoldenAdmissionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as root:
            cls.results = run(admission, Path(root))

    def test_golden_comes_from_master_and_covers_the_corpus(self):
        self.assertEqual(GOLDEN['commit'], 'cf4dedb2')
        self.assertEqual(set(GOLDEN['results']), set(self.results))

    def test_every_untightened_case_matches_master_exactly(self):
        for name, expected in GOLDEN['results'].items():
            if name in TIGHTENED: continue
            with self.subTest(case=name): self.assertEqual(self.results[name], expected)

    def test_each_tightening_was_admitted_on_master_and_is_refused_for_its_reason(self):
        for name, code in TIGHTENED.items():
            with self.subTest(case=name):
                self.assertNotIn('refusal', GOLDEN['results'][name])
                self.assertEqual(self.results[name], {'refusal': code})


if __name__ == '__main__':
    unittest.main()

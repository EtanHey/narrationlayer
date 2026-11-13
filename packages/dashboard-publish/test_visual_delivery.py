"""A visual page's delivery proof: a signed-in render of the served shell, its images, no answers, a signed-out 401."""
import base64
import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path

from gate import run

from admission import Refusal, admit, delivery, sha
import test_visual_media as visual_cases
from test_visual_media import VISUAL_SHELL, WEBP


class VisualDeliveryTest(unittest.TestCase):
    setUp = visual_cases.base.AdmissionTest.setUp
    visual = visual_cases.MediaTest.visual

    def proof(self, **changes):
        render = lambda width: {'width': width, 'signedIn': True, 'dashboardId': 'fixture-1', 'shellSha256': sha(VISUAL_SHELL),
                                'imagesLoaded': ['assets/a.webp'], 'noOverflow': True}
        value = {'method': 'visual-render', 'signedIn': True, 'renders': [render(390), render(1280)],
                 'media': [{'file': 'assets/a.webp', 'status': 200, 'contentType': 'image/webp', 'sha256': sha(WEBP), 'bytes': len(WEBP), 'loadedFrom': 'app1.ufs.sh'}],
                 'answerRowsAfter': 0, 'signedOut': {'request': 'media', 'status': 401}, 'existingRowsPreserved': 0, 'at': '2026-01-01T00:00:00Z'}
        return value | changes

    def deliver(self, proof, args=None):
        args = args or self.visual()
        return delivery(path=self.root / 'visual.json', handoff=args['handoff'], admission=admit(**args), shell=args['shell'], artifact=b'{}',
                        staging={'mode': 'unlisted-candidate', 'servedShellSha256': sha(args['shell']), 'accountProof': proof},
                        url='https://fixture.invalid/?d=fixture-1', approved_origins=['https://fixture.invalid'],
                        existing_rows=0, runtime_config=self.runtime_config, deliveries={})

    def refuse(self, code, proof, args=None):
        with self.assertRaises(Refusal) as raised: self.deliver(proof, args)
        self.assertEqual(raised.exception.code, code)
        self.assertFalse((self.root / 'visual.json').exists())

    def edited(self, path, value):
        proof = copy.deepcopy(self.proof()); target = proof
        for key in path[:-1]: target = target[key]
        target[path[-1]] = value
        return proof

    def test_a_passing_proof_writes_a_visual_receipt(self):
        receipt = self.deliver(self.proof())
        self.assertEqual((receipt['accountProof']['method'], receipt['admission']['pageType'], receipt['admission']['answerRuntime']), ('visual-render', 'visual', 'none'))
        self.assertEqual(receipt['servedShellSha256'], sha(VISUAL_SHELL))
        self.assertTrue((self.root / 'visual.json').exists())

    def test_each_condition_refuses_with_its_own_reason(self):
        cases = [('VISUAL_PROOF_RENDER', self.proof(renders=self.proof()['renders'][:1] * 2)),
                 ('VISUAL_PROOF_RENDER', self.edited(['renders', 1, 'shellSha256'], sha(b'another shell'))),
                 ('VISUAL_PROOF_RENDER', self.edited(['renders', 0, 'dashboardId'], 'other-page')),
                 ('VISUAL_PROOF_RENDER', self.edited(['renders', 1, 'imagesLoaded'], [])),
                 ('VISUAL_PROOF_MEDIA_STATUS', self.edited(['media', 0, 'status'], 404)),
                 ('VISUAL_PROOF_MEDIA_STATUS', self.edited(['media', 0, 'loadedFrom'], 'media.example.invalid')),
                 ('VISUAL_PROOF_MEDIA_STATUS', self.proof(media=[])),
                 ('VISUAL_PROOF_MEDIA_TYPE', self.edited(['media', 0, 'contentType'], 'audio/mpeg')),
                 ('VISUAL_PROOF_MEDIA_BYTES', self.edited(['media', 0, 'sha256'], sha(WEBP + b'other bytes'))),
                 ('VISUAL_PROOF_MEDIA_BYTES', self.edited(['media', 0, 'bytes'], len(WEBP) + 1)),
                 ('VISUAL_PROOF_ANSWER_ROWS', self.proof(answerRowsAfter=1)),
                 ('VISUAL_PROOF_SIGNED_OUT', self.proof(signedOut={'request': 'media', 'status': 200})),
                 ('VISUAL_PROOF_SIGNED_OUT', self.proof(signedOut={'request': 'media', 'status': 403})),
                 ('ACCOUNT_PROOF', self.proof(existingRowsPreserved=3)),
                 ('ACCOUNT_PROOF', self.edited(['renders', 0, 'noOverflow'], False))]
        for code, proof in cases:
            with self.subTest(code=code): self.refuse(code, proof)

    def test_a_charset_parameter_keeps_the_type(self):
        self.assertEqual(self.deliver(self.edited(['media', 0, 'contentType'], 'image/webp; charset=binary'))['dashboardId'], 'fixture-1')

    def test_a_visual_page_without_images_still_proves_the_media_endpoint_signed_out(self):
        args = self.visual(rows=[])
        empty = self.proof(media=[], renders=[r | {'imagesLoaded': [], 'shellSha256': sha(args['shell'])} for r in self.proof()['renders']])
        self.assertEqual(self.deliver(empty, args)['accountProof']['signedOut'], {'request': 'media', 'status': 401})

    def test_the_json_adapter_refuses_a_malformed_media_map_and_decodes_after_the_schema(self):
        args = self.visual()
        request = lambda media: {'handoff': args['handoff'], 'rawBase64': base64.b64encode(args['raw']).decode(), 'shellBase64': base64.b64encode(args['shell']).decode(),
            'dashboardId': 'fixture-1', 'savedKeys': [], 'deliveries': {}, 'provider': {}, 'artifactBase64': base64.b64encode(b'{}').decode(),
            'lock': str(self.lock), 'ownerPid': self.args['owner_pid'], 'runtimeConfig': str(self.runtime_config), 'mediaBase64': media}
        for media in (None, {}):
            with self.subTest(media=media): self.assertEqual(run(request(media))['pageType'], 'visual')
        for media in ('x', [], 7, {'assets/a.webp': 7}):
            with self.subTest(media=media), self.assertRaises(Refusal) as raised: run(request(media))
            self.assertEqual(raised.exception.code, 'ADMISSION_INPUT')
        # Bytes that are not base64 are never decoded when the schema refuses first, nor when no manifest row names them.
        broken = request({'assets/a.webp': '%%% not base64'}) | {'handoff': args['handoff'] | {'createdAt': None}}
        with self.assertRaises(Refusal) as raised: run(broken)
        self.assertEqual(raised.exception.code, 'HANDOFF_SCHEMA')
        self.assertEqual(run(request({'assets/unnamed.webp': '%%% not base64'}))['pageType'], 'visual')
        process = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('gate.py'))], input=json.dumps(request(None) | {'mediaBase64': 'x'}), capture_output=True, text=True)
        self.assertEqual((process.returncode, process.stderr.strip()), (1, 'ADMISSION_INPUT'))

    def test_neither_page_type_accepts_the_other_proof(self):
        roundtrip = {'signedIn': True, 'method': 'note-roundtrip', 'probe': 'existing-empty-field', 'markerSaved': True, 'restoredAfterLocalKeysCleared': True,
                     'cleanedUp': True, 'disposableRecord': True, 'independentClient': True, 'serverAck': True, 'mutationDelta': 2, 'existingRowsPreserved': 0, 'at': '2026-01-01T00:00:00Z'}
        self.refuse('PROOF_KIND', roundtrip)
        self.refuse('PROOF_KIND', self.proof(), self.args)
        self.refuse('PROOF_KIND', self.proof(method='note-roundtrip'))


if __name__ == '__main__':
    unittest.main()

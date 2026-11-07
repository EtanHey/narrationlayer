import json
import os
from pathlib import Path
import tempfile
import unittest

from admission import Refusal, admit, delivery, sha

RAW = b'<meta name="dashboard-id" content="fixture-1"><body data-storage-key="dbx:fixture-1">'
SHELL = RAW + b'<script>const s=window.__answerStore;s.load();s.save();s.onStatus();</script>'


class AdmissionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.lock = self.root / 'lock'
        self.lock.mkdir()
        (self.lock / 'owner.json').write_text(json.dumps({'pid': os.getpid()}))
        self.handoff = {'schema': 'audio-dashboard.publish-handoff.v2', 'dashboardId': 'fixture-1',
            'type': 'decision-flow', 'builtHtmlSha256': sha(b'single-file BUILD'), 'sourcePath': 'build', 'sourceHtmlSha256': sha(RAW),
            'buildReceiptsSha256': sha(b'receipts'), 'answerPersistence': 'PASS',
            'answerKeys': [{'key': 'note', 'kind': 'text'}], 'mediaManifest': [],
            'design': {'admission': 'FIRST_IN_LINEAGE', 'lineage': 'fixture', 'predecessorSha256': None},
            'createdAt': '2026-01-01T00:00:00Z'}
        self.args = dict(handoff=self.handoff, raw=RAW, shell=SHELL, dashboard_id='fixture-1',
            saved_keys=[{'key': 'note', 'kind': 'text'}], deliveries={},
            provider={'providerReady': True, 'servedShellSha256': sha(SHELL), 'savedSemantics': 'serverAck'},
            artifact=b'{}', lock=self.lock, owner_pid=os.getpid())

    def reject(self, code, **changes):
        with self.assertRaises(Refusal) as raised:
            admit(**(self.args | changes))
        self.assertEqual(raised.exception.code, code)

    def test_refusals(self):
        cases = [('HANDOFF_MISSING', {'handoff': None}), ('HANDOFF_SCHEMA', {'handoff': {}}),
            ('DASHBOARD_ID', {'dashboard_id': 'other'}), ('SOURCE_SHA', {'raw': RAW + b' '}),
            ('LINEAGE_EXISTS', {'deliveries': {'fixture': [{'accepted': True}]}}),
            ('ANSWER_PERSISTENCE', {'handoff': self.handoff | {'answerPersistence': 'FAIL'}}),
            ('ANSWER_IDENTITY', {'saved_keys': [{'key': 'old', 'kind': 'text'}]}),
            ('PROVIDER_NOT_READY', {'provider': {}}),
            ('SAVED_LOCAL_ONLY', {'provider': self.args['provider'] | {'savedSemantics': 'local'}}),
            ('ARTIFACT_TOO_LARGE', {'artifact': b'x' * (1048576 + 1)}),
            ('DEPLOY_LOCK', {'owner_pid': os.getpid() + 1})]
        for code, changes in cases:
            with self.subTest(code=code): self.reject(code, **changes)

    def test_build_and_prepared_hashes_are_distinct(self):
        self.assertNotEqual(self.handoff['builtHtmlSha256'], sha(RAW))
        self.assertEqual(admit(**self.args)['sourceHtmlSha256'], sha(RAW))
        self.reject('SOURCE_SHA', handoff=self.handoff | {'sourceHtmlSha256': self.handoff['builtHtmlSha256']})
        self.reject('HANDOFF_SCHEMA', handoff={k: v for k, v in self.handoff.items() if k != 'builtHtmlSha256'})

    def test_kind_scope_consumer_and_lineage(self):
        self.reject('ANSWER_IDENTITY', saved_keys=[{'key': 'note', 'kind': 'radio'}])
        for shell in [SHELL.replace(b'dbx:fixture-1', b'dbx:other'), SHELL + RAW]:
            self.reject('DASHBOARD_ID', shell=shell)
        self.reject('PROVIDER_NOT_READY', shell=RAW)
        self.reject('PROVIDER_NOT_READY', provider=self.args['provider'] | {'servedShellSha256': sha(b'old')})
        result = admit(**self.args)
        self.assertEqual(result['answerIdentity'], 'PASS')
        self.assertEqual(result['design'], self.handoff['design']['admission'])

    def test_delivery_is_bound_and_does_not_write_on_failure(self):
        admission = admit(**self.args)
        proof = {'signedIn': True, 'method': 'note-roundtrip', 'probe': 'existing-empty-field', 'markerSaved': True,
            'restoredAfterLocalKeysCleared': True, 'cleanedUp': True, 'disposableRecord': True,
            'independentClient': True, 'serverAck': True, 'mutationDelta': 2,
            'existingRowsPreserved': 1, 'at': '2026-01-01T00:00:00Z'}
        output = self.root / 'delivery.json'
        args = dict(path=output, handoff=self.handoff, admission=admission, shell=SHELL,
            artifact=b'{}', staging={'mode': 'unlisted-candidate',
                'servedShellSha256': sha(SHELL), 'accountProof': proof},
            url='https://fixture.invalid/?d=fixture-1', approved_origins=['https://fixture.invalid'],
            existing_rows=1)
        for changes in [{'shell': SHELL + b' '}, {'staging': args['staging'] | {'accountProof': proof | {'serverAck': False}}},
                        {'url': 'https://other.invalid/?d=fixture-1'}, {'existing_rows': 2}, {'staging': None}, {'handoff': None},
                        {'staging': args['staging'] | {'mode': 'none-backfill'}},
                        *[{'staging': args['staging'] | {'accountProof': p}} for p in
                          [{k: v for k, v in proof.items() if k != 'probe'}, proof | {'probe': 'user-data'}]]]:
            with self.subTest(changes=list(changes)), self.assertRaises(Refusal): delivery(**(args | changes))
            self.assertFalse(output.exists())
        receipt = delivery(**args)
        self.assertNotIn('backfilled', receipt)
        self.assertEqual(receipt['staging']['mode'], 'unlisted-candidate')
        self.assertEqual(json.loads(output.read_text()), receipt)
        self.assertEqual(receipt['sourceHtmlSha256'], sha(RAW))
        self.assertEqual(receipt['servedShellSha256'], receipt['staging']['servedShellSha256'])
        self.assertEqual(receipt['artifactSha256'], sha(b'{}'))



class BackfillDirectionTest(unittest.TestCase):
    setUp = AdmissionTest.setUp
    def test_normal_delivery_without_staging_is_refused(self):
        with self.assertRaises(Refusal):
            delivery(path=self.root / 'normal.json', handoff=self.handoff, admission=admit(**self.args),
                shell=SHELL, artifact=b'{}', url='https://fixture.invalid/?d=fixture-1',
                approved_origins=['https://fixture.invalid'], existing_rows=0)
        self.assertFalse((self.root / 'normal.json').exists())

    def test_backfill_requires_explicit_input_and_no_handoff(self):
        args = dict(path=self.root / 'backfill.json', shell=SHELL, artifact=b'{}',
            url='https://fixture.invalid/?d=fixture-1', approved_origins=['https://fixture.invalid'], existing_rows=0)
        proof = {key: True for key in ('signedIn', 'independentClient', 'disposableRecord', 'markerSaved',
            'serverAck', 'restoredAfterLocalKeysCleared', 'cleanedUp')}
        proof.update(method='note-roundtrip', probe='dedicated-key', mutationDelta=0, existingRowsPreserved=0, at='2026-01-01T00:00:00Z')
        explicit = dict(dashboardId='fixture-1', sourceHtmlSha256=sha(RAW), sourceHtml=RAW, accountProof=proof)
        with self.assertRaises(Refusal): delivery(**args, backfill=explicit, handoff=self.handoff)
        with self.assertRaises(Refusal): delivery(**args, backfill=explicit | {'sourceHtml': b'wrong'})
        receipt = delivery(**args, backfill=explicit)
        self.assertEqual(receipt['admission']['design'], 'UNKNOWN_BACKFILL')
        self.assertEqual(receipt['staging']['mode'], 'none-backfill')
        self.assertTrue(receipt['backfilled'])
        self.assertEqual(receipt['staging']['servedShellSha256'], sha(SHELL))

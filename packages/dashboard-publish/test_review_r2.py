"""Round-two regressions: exact refusal codes, with all sibling guards satisfied."""
import json
import base64
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
import unittest

import admission as product
from admission import Refusal, admit, delivery, sha
import test_admission as fixtures
from test_admission import RAW, SHELL, RUNTIME
from ratchet import check


class ReviewAdmissionTest(unittest.TestCase):
    setUp = fixtures.AdmissionTest.setUp
    reject = fixtures.AdmissionTest.reject

    def refuse(self, code, function, **args):
        with self.assertRaises(Refusal) as caught: function(**args)
        self.assertEqual(caught.exception.code, code)

    def receipt_args(self):
        proof = {key: True for key in ('signedIn', 'markerSaved', 'restoredAfterLocalKeysCleared',
            'cleanedUp', 'disposableRecord', 'independentClient', 'serverAck')}
        proof.update(method='note-roundtrip', probe='dedicated-key', mutationDelta=2,
                     existingRowsPreserved=0, at='2026-01-01T00:00:00Z')
        return dict(path=self.root / 'receipt.json', handoff=self.handoff, admission=admit(**self.args),
            shell=SHELL, artifact=b'{}', staging={'mode': 'unlisted-candidate',
            'servedShellSha256': sha(SHELL), 'accountProof': proof},
            url='https://fixture.invalid/?d=fixture-1', approved_origins=['https://fixture.invalid'],
            existing_rows=0, runtime_config=self.runtime_config, deliveries={})

    def backfill_args(self):
        args = self.receipt_args()
        proof = args.pop('staging')['accountProof']
        args.pop('admission'); args.pop('handoff')
        args['backfill'] = dict(dashboardId='fixture-1', sourceHtmlSha256=sha(RAW), sourceHtml=RAW,
            accountProof=proof, answerIdentity='PASS', providerReady=True)
        return args

    def test_second_unrelated_deploy_preserves_accepted_first_shell(self):
        registry = {'fixture': [{'accepted': True, 'dashboardId': 'fixture-1', 'sourceHtmlSha256': sha(RAW)}]}
        self.assertEqual(admit(**(self.args | {'deliveries': registry}))['answerIdentity'], 'PASS')
        registry['fixture'].append({'accepted': True, 'dashboardId': 'fixture-b', 'sourceHtmlSha256': sha(b'B')})
        self.assertEqual(admit(**(self.args | {'deliveries': registry}))['answerIdentity'], 'PASS')
        other_raw, other_shell = RAW.replace(b'fixture-1', b'fixture-2'), SHELL.replace(b'fixture-1', b'fixture-2')
        handoff = self.handoff | {'dashboardId': 'fixture-2', 'sourceHtmlSha256': sha(other_raw),
            'design': self.handoff['design'] | {'lineage': 'unrelated'}}
        self.assertEqual(admit(**(self.args | dict(handoff=handoff, raw=other_raw, shell=other_shell,
            dashboard_id='fixture-2', deliveries=registry,
            provider=self.args['provider'] | {'servedShellSha256': sha(other_shell)})))['answerIdentity'], 'PASS')
        for row in [dict(dashboardId='fixture-2', sourceHtmlSha256=sha(RAW)),
                    dict(dashboardId='fixture-1', sourceHtmlSha256=sha(b'changed'))]:
            self.reject('LINEAGE_EXISTS', deliveries={'fixture': [row | {'accepted': True}]})

    def test_handoff_id_binding_is_independent_of_html_scope(self):
        self.reject('DASHBOARD_ID', handoff=self.handoff | {'dashboardId': 'other'})

    def test_id_format_and_length_with_all_scopes_aligned(self):
        for identifier in ['BAD', 'x' * 97]:
            raw, shell = RAW.replace(b'fixture-1', identifier.encode()), SHELL.replace(b'fixture-1', identifier.encode())
            self.reject('DASHBOARD_ID', handoff=self.handoff | {'dashboardId': identifier, 'sourceHtmlSha256': sha(raw)},
                raw=raw, shell=shell, dashboard_id=identifier,
                provider=self.args['provider'] | {'servedShellSha256': sha(shell)})

    def test_duplicate_answer_keys(self):
        self.reject('ANSWER_IDENTITY', handoff=self.handoff | {'answerKeys': self.handoff['answerKeys'] * 2})

    def test_prepared_input_runtime_is_checked_independently(self):
        raw = RAW.replace(RUNTIME, RUNTIME.replace(b'fixture', b'altered'))
        self.reject('ANSWER_RUNTIME_MISMATCH', raw=raw, handoff=self.handoff | {'sourceHtmlSha256': sha(raw)})

    def test_each_consumer_token_with_matching_provider_hash(self):
        for token in (b'__answerStore', b'.load(', b'.save(', b'.onStatus('):
            shell = SHELL.replace(token, b'absent')
            self.reject('PROVIDER_NOT_READY', shell=shell,
                provider=self.args['provider'] | {'servedShellSha256': sha(shell)})

    def test_live_nonancestor_lock_owner(self):
        child = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read()'], stdin=subprocess.PIPE)
        try:
            (self.lock / 'owner.json').write_text(json.dumps({'pid': child.pid}))
            self.reject('DEPLOY_LOCK', owner_pid=child.pid)
        finally:
            child.stdin.close(); child.wait(timeout=10)

    def test_runtime_config_invalid_status(self):
        self.runtime_config.write_text(json.dumps([{'sha256': sha(RUNTIME), 'status': 'unreviewed', 'note': ''}]))
        self.reject('ANSWER_RUNTIME_CONFIG')

    def test_created_at_format_is_actually_validated(self):
        self.reject('HANDOFF_SCHEMA', handoff=self.handoff | {'createdAt': 'not-a-date'})

    def test_forged_current_and_deprecated_runtime_echoes(self):
        args = self.receipt_args()
        self.refuse('ANSWER_RUNTIME_ECHO', delivery, **(args | {'admission': args['admission'] | {'answerRuntime': 'deprecated'}}))
        self.runtime_config.write_text(json.dumps([{'sha256': sha(RUNTIME), 'status': 'deprecated', 'note': 'fixture'}]))
        args['admission']['answerRuntime'] = 'current'
        self.refuse('ANSWER_RUNTIME_ECHO', delivery, **args)
        args['admission']['answerRuntime'] = 'deprecated'
        self.assertEqual(delivery(**args)['admission']['answerRuntime'], 'deprecated')

    def test_delivery_each_admission_binding(self):
        args = self.receipt_args()
        for field, value, code in [('sourceHtmlSha256', sha(b'wrong'), 'ADMISSION_SOURCE'),
            ('dashboardId', 'other', 'ADMISSION_ID'), ('design', 'COMPARED', 'ADMISSION_DESIGN'),
            ('servedShellSha256', sha(b'wrong'), 'ADMISSION_SHELL')]:
            with self.subTest(field=field):
                self.refuse(code, delivery, **(args | {'admission': args['admission'] | {field: value}}))
                self.assertFalse(args['path'].exists())
        self.refuse('STAGING_SHELL', delivery, **(args | {'staging': args['staging'] | {'servedShellSha256': sha(b'wrong')}}))
        self.refuse('STAGING_MODE', delivery, **(args | {'staging': args['staging'] | {'mode': 'none-backfill'}}))
        self.refuse('STAGING_PROOF', delivery, **(args | {'staging': None}))

    def test_account_schema_and_row_count_have_account_code(self):
        args = self.receipt_args()
        proof = args['staging']['accountProof']
        for bad in [proof | {'serverAck': False}, proof | {'probe': 'invalid'},
                    proof | {'existingRowsPreserved': 1}, proof | {'at': 'not-a-date'}]:
            self.refuse('ACCOUNT_PROOF', delivery, **(args | {'staging': args['staging'] | {'accountProof': bad}}))
            self.assertFalse(args['path'].exists())

    def test_backfill_id_binds_both_prepared_input_and_shell(self):
        args = self.backfill_args()
        wrong = args['backfill'] | {'dashboardId': 'someone-else'}
        self.refuse('DASHBOARD_ID', delivery, **(args | {'backfill': wrong, 'url': 'https://fixture.invalid/?d=someone-else'}))
        for field in ['shell', 'sourceHtml']:
            wrong_html = (SHELL if field == 'shell' else RAW).replace(b'dbx:fixture-1', b'dbx:other')
            changes = {'shell': wrong_html} if field == 'shell' else {'backfill': args['backfill'] | {
                'sourceHtml': wrong_html, 'sourceHtmlSha256': sha(wrong_html)}}
            self.refuse('DASHBOARD_ID', delivery, **(args | changes))

    def test_backfill_requires_observed_identity_and_provider(self):
        args = self.backfill_args()
        for field, bad in [('answerIdentity', 'FAIL'), ('providerReady', False)]:
            for value in [bad, None]:
                observation = args['backfill'] | {field: value}
                if value is None: observation.pop(field)
                self.refuse('BACKFILL_INPUT' if value is None else 'BACKFILL_OBSERVATIONS', delivery, **(args | {'backfill': observation}))

    def test_prepared_index_must_not_be_symlink_or_escape(self):
        source = self.root / 'build'; source.mkdir()
        outside = self.root / 'outside.html'; outside.write_bytes(RAW)
        inside = source / 'real.html'; inside.write_bytes(RAW)
        for target in [inside, outside]:
            (source / 'index.html').symlink_to(target)
            self.refuse('SOURCE_PATH', product.read_prepared_index, source=source)
            (source / 'index.html').unlink()
        (source / 'index.html').write_bytes(RAW)
        self.assertEqual(product.read_prepared_index(source), RAW)

    def test_missing_backfill_source_is_a_refusal(self):
        args = self.backfill_args(); args['backfill'].pop('sourceHtml')
        self.refuse('BACKFILL_INPUT', delivery, **args)

    def test_missing_format_validators_refuse(self):
        checker = product.FormatChecker(); checker.checkers = {}
        with patch.object(product, 'FormatChecker', return_value=checker):
            self.refuse('FORMAT_VALIDATORS', product.validator, schema={})

    def test_delivery_query_id_is_bound(self):
        self.refuse('DELIVERY_ORIGIN', delivery, **(self.receipt_args() | {'url': 'https://fixture.invalid/?d=other'}))

    def test_first_approval_missing(self):
        self.handoff['design'].pop('firstInLineage', None)
        self.reject('FIRST_IN_LINEAGE_UNAPPROVED')

    def test_first_approval_empty(self):
        self.handoff['design']['firstInLineage'] = {'reason': 'fixture', 'approvedBy': ''}
        self.reject('FIRST_IN_LINEAGE_UNAPPROVED')

    def test_first_approval_unrecorded(self):
        self.handoff['design']['firstInLineage'] = {'reason': 'fixture', 'approvedBy': 'UNRECORDED'}
        self.reject('FIRST_IN_LINEAGE_UNAPPROVED')

    def test_unknown_staging_mode_refuses(self):
        args = self.receipt_args()
        self.refuse('INVALID_STAGING_MODE', delivery, **(args | {'staging': args['staging'] | {'mode': 'invented'}}))
        self.reject('INVALID_STAGING_MODE', staging={'mode': 'invented'})

    def test_in_place_maintenance_requirements_and_receipt(self):
        args = self.receipt_args()
        compared = self.handoff | {'design': {'admission': 'COMPARED', 'lineage': 'fixture', 'predecessorSha256': sha(RAW)}}
        history = {'fixture': [{'accepted': True, 'dashboardId': 'fixture-1', 'servedShellSha256': sha(b'previous')}]}
        args.update(handoff=compared, admission=admit(**(self.args | {'handoff': compared})), deliveries=history)
        args['staging'].update(mode='in-place-maintenance', previousServedShellSha256=sha(b'previous'))
        for previous in [None, 'bad', sha(SHELL)]:
            self.refuse('MAINTENANCE_PREVIOUS_SHELL', delivery, **(args | {'staging': args['staging'] | {'previousServedShellSha256': previous}}))
        wrong = {'fixture': [{'accepted': True, 'dashboardId': 'fixture-1', 'servedShellSha256': sha(b'other') }]}
        self.refuse('MAINTENANCE_PREVIOUS_SHELL', delivery, **(args | {'deliveries': wrong}))
        same = {'fixture': [{'accepted': True, 'dashboardId': 'fixture-1', 'servedShellSha256': sha(SHELL)}]}
        self.refuse('MAINTENANCE_PREVIOUS_SHELL', delivery, **(args | {'deliveries': same, 'staging': args['staging'] | {'previousServedShellSha256': sha(SHELL)}}))
        self.refuse('MAINTENANCE_DESIGN', delivery, **(args | {'handoff': self.handoff}))
        self.refuse('MAINTENANCE_NOT_ACCEPTED', delivery, **(args | {'deliveries': {}}))
        self.reject('MAINTENANCE_NOT_ACCEPTED', handoff=compared, staging=args['staging'])
        self.assertEqual(admit(**(self.args | {'handoff': compared, 'staging': args['staging'], 'deliveries': history}))['answerIdentity'], 'PASS')
        receipt = delivery(**args)
        self.assertEqual(receipt['staging']['mode'], 'in-place-maintenance'); self.assertNotIn('backfilled', receipt)

    def test_existing_id_requires_maintenance_mode(self):
        args = self.receipt_args()
        history = {'fixture': [{'accepted': True, 'dashboardId': 'fixture-1', 'sourceHtmlSha256': sha(RAW)}]}
        self.refuse('MAINTENANCE_REQUIRED', delivery, **(args | {'deliveries': history}))
        self.reject('MAINTENANCE_REQUIRED', staging=args['staging'], deliveries=history)

    def test_first_reason_is_recorded_and_nonblank(self):
        for reason in [None, '', '   ']:
            approval = {'approvedBy': 'fixture-reviewer'}
            if reason is not None: approval['reason'] = reason
            self.handoff['design']['firstInLineage'] = approval
            self.reject('FIRST_IN_LINEAGE_UNAPPROVED')

    def test_unrecorded_owner_is_case_insensitive_in_code_and_schema(self):
        for owner in ['unrecorded', '  UnReCoRdEd  ']:
            self.handoff['design']['firstInLineage'] = {'reason': 'fixture', 'approvedBy': owner}
            self.reject('FIRST_IN_LINEAGE_UNAPPROVED')
            self.refuse('HANDOFF_SCHEMA', lambda: product.validate(self.handoff, 'publish-handoff', 'HANDOFF_SCHEMA'))

    def test_invalid_staging_through_stdin_gate(self):
        request = dict(handoff=self.handoff, rawBase64=base64.b64encode(RAW).decode(),
            shellBase64=base64.b64encode(SHELL).decode(), artifactBase64=base64.b64encode(b'{}').decode(),
            dashboardId='fixture-1', savedKeys=self.args['saved_keys'], deliveries={}, provider=self.args['provider'],
            lock=str(self.lock), ownerPid=os.getpid(), runtimeConfig=str(self.runtime_config), staging={'mode': 'invalid'})
        result = subprocess.run([sys.executable, '-B', str(product.ROOT / 'gate.py')], input=json.dumps(request), capture_output=True, text=True)
        self.assertEqual(result.returncode, 1); self.assertEqual(result.stderr.strip(), 'INVALID_STAGING_MODE')

    def test_each_required_backfill_key_is_checked_up_front(self):
        args = self.backfill_args()
        for key in args['backfill']:
            missing = {k: v for k, v in args['backfill'].items() if k != key}
            self.refuse('BACKFILL_INPUT', delivery, **(args | {'backfill': missing}))

    def test_registry_shape_is_checked_for_all_lineages(self):
        args = self.receipt_args()
        for registry in [[], {'briefings': {}}, {'briefings': [None]}, {'briefings': ['row']}]:
            self.reject('DELIVERIES_SCHEMA', deliveries=registry)
            self.refuse('DELIVERIES_SCHEMA', delivery, **(args | {'deliveries': registry}))


class ReviewRatchetTest(unittest.TestCase):
    def test_each_python_statement_and_command_bypass(self):
        cases = [
            'with Request(url, method="PUT") as r:\n    pass',
            'if requests.put(url):\n    pass',
            'r: object = requests.put(url)',
            'requests.put(url)',
            'Request(url, method=verb)',
            'subprocess.run(["lakebed",\n "deploy", "--json"])',
            'subprocess.run("lakebed deploy --json", shell=True)',
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'publisher.py'
            for source in cases:
                with self.subTest(source=source):
                    path.write_text(source)
                    self.assertEqual([row.split(':')[0] for row in check([path])], ['RATCHET_UNGATED_PUT'])
                    path.write_text('assert_publish_admission(envelope)\n' + source)
                    self.assertEqual(check([path]), [])
            path.write_text('def assert_publish_admission(e):\n    pass\nassert_publish_admission(e)\nrequests.put(url)')
            self.assertIn('RATCHET_GATE_REDEFINED', [row.split(':')[0] for row in check([path])])

    def test_each_javascript_bypass(self):
        cases = ['fetch(url, {method: verb});', 'requests.put(url);',
            'execSync("lakebed deploy --json");', 'execFileSync("lakebed", [\n"deploy", "--json"]);']
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'publisher.mjs'
            for source in cases:
                with self.subTest(source=source):
                    path.write_text(source)
                    self.assertEqual([row.split(':')[0] for row in check([path])], ['RATCHET_UNGATED_PUT'])
                    path.write_text('assertPublishAdmission(envelope);\n' + source)
                    self.assertEqual(check([path]), [])
            path.write_text('function assertPublishAdmission(e){}\nassertPublishAdmission(e);\nfetch(url, {method:"PUT"});')
            self.assertIn('RATCHET_GATE_REDEFINED', [row.split(':')[0] for row in check([path])])

    def test_import_path_is_exact(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'publisher.mjs'
            source = "import {assertPublishAdmission} from './evil-publish-admission.mjs'; assertPublishAdmission(e); fetch(url,{method:'PUT'});"
            path.write_text(source)
            self.assertEqual([row.split(':')[0] for row in check([path])], ['RATCHET_GATE_REDEFINED'])
            path.write_text(source.replace('evil-publish', 'publish')); self.assertEqual(check([path]), [])
            self.assertEqual(check([path], path.parent / 'publish-admission.mjs'), [])
            self.assertEqual([row.split(':')[0] for row in check([path], path.parent / 'elsewhere/publish-admission.mjs')], ['RATCHET_GATE_REDEFINED'])

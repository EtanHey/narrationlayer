"""Follow-up boundaries: explicit history and recorded single-line approvals."""
import unittest

import admission as product
from admission import Refusal, admit, delivery, sha
from test_admission import RAW, SHELL
import test_review_r2 as fixtures


class ApprovalRegistryTest(unittest.TestCase):
    setUp = fixtures.ReviewAdmissionTest.setUp
    receipt_args = fixtures.ReviewAdmissionTest.receipt_args
    backfill_args = fixtures.ReviewAdmissionTest.backfill_args
    refuse = fixtures.ReviewAdmissionTest.refuse

    def design(self, admission, approval):
        return {'admission': admission, 'lineage': 'fixture',
            'predecessorSha256': None if admission == 'FIRST_IN_LINEAGE' else sha(RAW),
            'firstInLineage' if admission == 'FIRST_IN_LINEAGE' else 'redesign': approval}

    def test_normal_receipt_requires_registry_even_when_omitted(self):
        args = self.receipt_args(); args.pop('deliveries')
        for index, change in enumerate(({}, {'deliveries': None})):
            with self.subTest(change=change):
                candidate = args | change | {'path': self.root / f'normal-{index}.json'}
                self.refuse('DELIVERIES_SCHEMA', delivery, **candidate)
                self.assertFalse(candidate['path'].exists())
        self.assertEqual(delivery(**args, deliveries={})['admission']['answerIdentity'], 'PASS')

    def test_backfill_needs_no_registry_and_cannot_claim_normal_pass(self):
        args = self.backfill_args(); args.pop('deliveries')
        for index, change in enumerate(({}, {'deliveries': None})):
            receipt = delivery(**(args | change | {'path': self.root / f'backfill-{index}.json'}))
            self.assertTrue(receipt['backfilled'])
            self.assertEqual(receipt['staging']['mode'], 'none-backfill')
            self.assertEqual(receipt['admission']['design'], 'UNKNOWN_BACKFILL')

    def test_approval_refusals_and_schema(self):
        for mode, code in [('FIRST_IN_LINEAGE', 'FIRST_IN_LINEAGE_UNAPPROVED'), ('REDESIGN_APPROVED', 'REDESIGN_UNAPPROVED')]:
            for field in ('reason', 'approvedBy'):
                invalid = [None, '', '   ', *['a' + separator + 'b' for separator in ('\n', '\r', '\r\n', '\v', '\x85', '\u2028', '\u2029')]]
                if field == 'approvedBy': invalid += ['UNRECORDED', '  unRecorded  ']
                for value in invalid:
                    with self.subTest(mode=mode, field=field, value=value):
                        approval = {'reason': 'fixture', 'approvedBy': 'fixture-reviewer', 'from': sha(RAW)}
                        if mode == 'FIRST_IN_LINEAGE': approval.pop('from')
                        if value is None: approval.pop(field)
                        else: approval[field] = value
                        handoff = self.handoff | {'design': self.design(mode, approval)}
                        self.refuse(code, admit, **(self.args | {'handoff': handoff}))
                        self.refuse('HANDOFF_SCHEMA', lambda: product.validate(handoff, 'publish-handoff', 'HANDOFF_SCHEMA'))
            approval = {'reason': ' fixture ', 'approvedBy': ' fixture-reviewer '}
            if mode == 'REDESIGN_APPROVED': approval['from'] = sha(RAW)
            self.assertEqual(admit(**(self.args | {'handoff': self.handoff | {'design': self.design(mode, approval)}}))['design'], mode)

    def test_admit_refuses_previous_equal_to_candidate(self):
        handoff = self.handoff | {'design': {'admission': 'COMPARED', 'lineage': 'fixture', 'predecessorSha256': sha(RAW)}}
        self.refuse('MAINTENANCE_PREVIOUS_SHELL', admit, **(self.args | {'handoff': handoff,
            'staging': {'mode': 'in-place-maintenance', 'previousServedShellSha256': sha(SHELL)},
            'deliveries': {'fixture': [{'accepted': True, 'dashboardId': 'fixture-1', 'servedShellSha256': sha(SHELL)}]}}))

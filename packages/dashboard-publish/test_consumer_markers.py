"""Real, hash-pinned public runtime fixtures; these prove static checks only."""
import json
from pathlib import Path
import re
import unittest

from admission import ROOT, admit, sha, Refusal
import test_admission as fixtures


class ConsumerMarkersTest(unittest.TestCase):
    setUp = fixtures.AdmissionTest.setUp

    def args_for(self, name, runtime=None):
        config = json.loads((ROOT / 'answer-runtimes.json').read_text())
        entry = next(e for e in config if e['status'] == name)
        original = (ROOT / 'fixtures/answer-runtimes' / (name + '.js')).read_bytes().strip()
        self.assertEqual(sha(original), entry['sha256'])
        raw = b'<meta name="dashboard-id" content="fixture-1"><body data-storage-key="dbx:fixture-1"><script>' + (original if runtime is None else runtime) + b'</script>'
        return self.args | dict(raw=raw, shell=raw, saved_keys=[], runtime_config=ROOT / 'answer-runtimes.json',
            handoff=self.handoff | {'answerKeys': [], 'answerRuntimeSha256': entry['sha256'], 'sourceHtmlSha256': sha(raw),
                'design': {'admission': 'COMPARED', 'lineage': 'fixture', 'predecessorSha256': sha(b'previous')}},
            deliveries={'fixture': [{'accepted': True, 'dashboardId': 'fixture-1'}]} if name == 'deprecated' else {},
            provider=self.args['provider'] | {'servedShellSha256': sha(raw)})

    def test_real_current_and_deprecated_consumers(self):
        for name in ('current', 'deprecated'):
            with self.subTest(name=name):
                args = self.args_for(name)
                self.assertEqual(admit(**args)['answerRuntime'], name)
                if name == 'deprecated':
                    with self.assertRaises(Refusal) as error: admit(**(args | {'deliveries': {}}))
                    self.assertEqual(error.exception.code, 'ANSWER_RUNTIME_DEPRECATED_NEW')

    def test_removed_status_subscription_is_not_provider_ready(self):
        for name in ('current', 'deprecated'):
            runtime = (ROOT / 'fixtures/answer-runtimes' / (name + '.js')).read_text().strip()
            broken, count = re.subn(r"      listen\(remote, 'onStatus',[\s\S]*?\n      \}\);\n", '', runtime, count=1)
            self.assertEqual(count, 1)
            args = self.args_for(name, broken.encode())
            config = json.loads((ROOT / 'answer-runtimes.json').read_text())
            # Align sibling hash guards to isolate the missing-consumer check.
            entry = next(e for e in config if e['status'] == name); entry['sha256'] = sha(broken.encode())
            self.runtime_config.write_text(json.dumps(config)); args['runtime_config'] = self.runtime_config
            args['handoff']['answerRuntimeSha256'] = entry['sha256']
            with self.subTest(name=name), self.assertRaises(Refusal) as error: admit(**args)
            self.assertEqual(error.exception.code, 'PROVIDER_NOT_READY')

    def test_missing_or_invalid_markers_refuse_config(self):
        args = self.args_for('current')
        for value in (None, [], [''], ['  '], [1], '__answerStore'):
            config = json.loads((ROOT / 'answer-runtimes.json').read_text())
            if value is None: config[0].pop('consumerMarkers', None)
            else: config[0]['consumerMarkers'] = value
            self.runtime_config.write_text(json.dumps(config))
            with self.subTest(value=value), self.assertRaises(Refusal) as error: admit(**(args | {'runtime_config': self.runtime_config}))
            self.assertEqual(error.exception.code, 'ANSWER_RUNTIME_CONFIG')

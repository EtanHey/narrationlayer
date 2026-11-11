"""Real probe entry point; all network, power and inbox effects stay isolated."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

path = os.environ.get('PROBE_UNDER_TEST', str(Path(__file__).resolve().parents[1] / 'scripts/runtime-probe/probe.py'))
spec = importlib.util.spec_from_file_location('probe', path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inbox = self.root / 'inbox.md'
        self.config_path = self.root / 'probe.json'
        self.config = {'host': 'https://media.example', 'app': 'https://app.example/?d=retired',
                       'clip_url': 'https://media.example/clip', 'relay_url': 'https://media.example/relay',
                       'audio_url': 'https://app.example/api/audio?d=current&f=clip',
                       'inbox_path': str(self.inbox), 'token_file': str(self.root / 'token'),
                       'launchd_labels': ['org.example.media'], 'funnel_port': 8443}
        self.config_path.write_text(json.dumps(self.config))
        (self.root / 'token').write_text('test-token')
        self.offline = self.head_down = self.failed = False
        self.power = '2000-01-01 00:00:00 +0000 Wake                 Wake from Normal Sleep'
        self.urls = []
        env = {'NL_PROBE_CONFIG': str(self.config_path), 'NL_PROBE_INBOX': str(self.inbox)}
        env.update({key: self.config[field] for field, key in {
            'clip_url': 'NL_PROBE_CLIP_URL', 'relay_url': 'NL_PROBE_RELAY_URL',
            'audio_url': 'NL_PROBE_AUDIO_URL', 'app': 'NL_PROBE_APP_URL'}.items()})
        for mock in (patch.dict(os.environ, env, clear=True), patch.object(probe, 'STATE', self.root / 'state'),
                     patch.object(probe, 'TOKEN', self.root / 'token', create=True),
                     patch.object(probe, 'run', side_effect=self.run_command),
                     patch('socket.getaddrinfo', side_effect=self.resolve)):
            mock.start()
            self.addCleanup(mock.stop)

    def resolve(self, *args):
        if self.offline:
            raise socket.gaierror('offline')
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('192.0.2.1', 443))]

    def run_command(self, args, stdin=None):
        if 'curl' in args[0]:
            url = args[-1]
            self.urls.append(url)
            if '--head' in args:
                return (1, '000') if self.offline or self.head_down else (0, '200')
            if url.startswith('https://app.example/') and '/api/' not in url:
                return (1, '000') if self.failed else (0, '200')
            return 0, '401' if '/api/' in url else '206'
        if 'pmset' in args[0]:
            return 0, self.power
        if 'launchctl' in args[0]:
            return 0, ' pid = 42\n'
        return 0, '{"AllowFunnel":{"media.example:8443":true}}'

    def invoke(self):
        with contextlib.redirect_stdout(io.StringIO()):
            code = probe.main()
        return code, json.loads((probe.STATE / 'last.json').read_text())

    def notices(self):
        return self.inbox.read_text() if self.inbox.exists() else ''

    def test_offline_skips_without_post(self):
        self.offline = self.failed = True
        code, state = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(state['status'], 'SKIPPED client-offline')
        self.assertFalse(self.notices())
        self.assertEqual(len(self.urls), 2)  # Only the two public HEAD requests.
        self.assertFalse(state['client']['www.apple.com']['dns'])

    def test_asleep_skips_without_post(self):
        self.failed = True
        for kind in ('DarkWake', 'Sleep'):
            self.power = f'2000-01-01 00:00:00 +0000 {kind}                 sleep transition'
            self.assertEqual(self.invoke()[1]['status'], 'SKIPPED client-asleep')
        self.assertFalse(self.notices())

    def test_recent_wake_skips(self):
        self.power = probe.datetime.datetime.now(probe.datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S %z') + ' Wake                 full wake'
        self.assertEqual(self.invoke()[1]['status'], 'SKIPPED client-asleep')
        self.assertFalse(self.notices())

    def test_real_failure_posts_once_then_recovers(self):
        self.failed = True
        self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(self.invoke()[1]['status'], 'FAIL')
        self.assertEqual(self.notices().count('runtime FAIL'), 1)
        self.failed = False
        self.assertTrue(self.invoke()[1]['healthy'])
        self.assertEqual(self.notices().count('runtime RECOVERY'), 1)

    def test_healthy_uses_root_and_no_post(self):
        self.assertEqual(self.invoke()[0], 0)
        self.assertIn('https://app.example/', self.urls)
        self.assertNotIn(self.config['app'], self.urls)
        self.assertFalse(self.notices())

    def assert_config_error_once(self):
        code, state = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(state['status'], 'CONFIG-ERROR')
        self.invoke()
        self.assertEqual(self.notices().count('runtime CONFIG-ERROR'), 1)
        self.assertFalse(self.urls)

    def test_missing_config_posts_once(self):
        self.config_path.unlink()
        self.assert_config_error_once()

    def test_unparseable_config_posts_once(self):
        self.config_path.write_text('{broken')
        self.assert_config_error_once()

    def test_skips_preserve_failure_transition(self):
        self.failed = True
        self.invoke()
        self.offline = True
        self.invoke()
        self.offline = False
        self.invoke()
        self.assertEqual(self.notices().count('runtime FAIL'), 1)
        self.failed = False
        self.invoke()
        self.assertEqual(self.notices().count('runtime RECOVERY'), 1)

    def test_config_recovery_and_regression_post_again(self):
        self.config_path.write_text('{')
        self.invoke()
        self.config_path.write_text(json.dumps(self.config))
        self.assertTrue(self.invoke()[1]['healthy'])
        self.config_path.unlink()
        self.invoke()
        self.assertEqual(self.notices().count('runtime CONFIG-ERROR'), 2)
        self.assertEqual(self.notices().count('runtime RECOVERY'), 1)

    def test_dns_alone_does_not_establish_connectivity(self):
        self.head_down = True
        self.assertEqual(self.invoke()[1]['status'], 'SKIPPED client-offline')


if __name__ == '__main__':
    unittest.main()

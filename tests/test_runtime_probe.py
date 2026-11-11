"""Real probe entry point; all network, power and inbox effects stay isolated."""
import builtins
import contextlib
import datetime
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
        self.head_status = '200'
        self.power = '2000-01-01 00:00:00 +0000 Wake                 Wake from Normal Sleep'
        self.urls = []
        env = {'NL_PROBE_CONFIG': str(self.config_path), 'NL_PROBE_INBOX': str(self.inbox),
               'NL_PROBE_STATE_DIR': str(self.root / 'state'),
               'NL_PROBE_TOKEN_FILE': str(self.root / 'token')}
        env.update({key: self.config[field] for field, key in {
            'clip_url': 'NL_PROBE_CLIP_URL', 'relay_url': 'NL_PROBE_RELAY_URL',
            'audio_url': 'NL_PROBE_AUDIO_URL', 'app': 'NL_PROBE_APP_URL'}.items()})
        environment = patch.dict(os.environ, env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        # Legacy probes capture paths at import: install the environment FIRST.
        spec = importlib.util.spec_from_file_location('probe', path)
        self.probe = importlib.util.module_from_spec(spec)
        exec(compile(Path(path).read_text(), path, 'exec'), self.probe.__dict__)
        for mock in (patch.object(self.probe, 'run', side_effect=self.run_command),
                     patch('socket.getaddrinfo', side_effect=self.resolve)):
            mock.start()
            self.addCleanup(mock.stop)

    @contextlib.contextmanager
    def guarded_writes(self):
        allowed_fds = set()
        def require_temporary(target):
            if not Path(target).expanduser().resolve().is_relative_to(self.root.resolve()):
                raise AssertionError('Probe write outside temporary test directory refused')

        def wrap_open(opener):
            def guarded(target, mode='r', *args, **kwargs):
                writing = mode & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND) if isinstance(mode, int) else any(c in mode for c in 'wax+')
                if writing:
                    if isinstance(target, int):
                        self.assertIn(target, allowed_fds, 'Unowned file descriptor')
                    else:
                        require_temporary(target)
                result = opener(target, mode, *args, **kwargs)
                if isinstance(mode, int):
                    allowed_fds.add(result)
                return result
            return guarded

        replace, mkdir = os.replace, os.mkdir
        def guarded_replace(source, target, *args, **kwargs):
            require_temporary(source)
            require_temporary(target)
            return replace(source, target, *args, **kwargs)
        def guarded_mkdir(target, *args, **kwargs):
            require_temporary(target)
            return mkdir(target, *args, **kwargs)
        with patch('builtins.open', wrap_open(builtins.open)), patch('io.open', wrap_open(io.open)), \
                patch('os.open', wrap_open(os.open)), patch('os.replace', guarded_replace), \
                patch('os.mkdir', guarded_mkdir):
            yield

    def resolve(self, *args):
        if self.offline:
            raise socket.gaierror('offline')
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('192.0.2.1', 443))]

    def run_command(self, args, stdin=None):
        if 'curl' in args[0]:
            url = args[-1]
            self.urls.append(url)
            if '--head' in args:
                return (1, '000') if self.offline or self.head_down else (0, self.head_status)
            if url.startswith('https://app.example/') and '/api/' not in url:
                return (1, '000') if self.failed else (0, '200')
            return 0, '401' if '/api/' in url else '206'
        if 'pmset' in args[0]:
            return 0, self.power
        if 'launchctl' in args[0]:
            return 0, ' pid = 42\n'
        return 0, '{"AllowFunnel":{"media.example:8443":true}}'

    def invoke(self):
        for key in ('NL_PROBE_CONFIG', 'NL_PROBE_STATE_DIR', 'NL_PROBE_INBOX'):
            self.assertTrue(Path(os.environ[key]).resolve().is_relative_to(self.root.resolve()), key)
        with self.guarded_writes(), contextlib.redirect_stdout(io.StringIO()):
            code = self.probe.main()
        return code, json.loads((self.probe.STATE / 'last.json').read_text())

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
            self.power = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S %z') + f' {kind}                 sleep transition'
            self.assertEqual(self.invoke()[1]['status'], 'SKIPPED client-asleep')
        self.assertFalse(self.notices())

    def test_recent_wake_skips(self):
        self.power = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S %z') + ' Wake                 full wake'
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

    def test_wake_requests_after_real_sleep_is_not_a_wake(self):
        # Real pmset lines; omit other system requests after the first bracket.
        self.power = (
            "2026-11-11 22:58:38 +0200 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using Batt (Charge:50%) 3 secs    \n"
            '2026-11-11 22:58:40 +0200 Wake Requests       \t[process=mDNSResponder request=Maintenance deltaSecs=7198 wakeAt=2026-11-12 00:58:38 info="upkeep wake"]\n'
        )
        now = datetime.datetime.fromisoformat('2026-11-11T23:08:38+02:00')
        class Clock(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                return now.astimezone(tz)
        self.failed = True
        with patch.object(self.probe.datetime, 'datetime', Clock):
            code, state = self.invoke()
        self.assertEqual(state['client']['power']['event'], 'Sleep')
        self.assertEqual(state['client']['power']['age_seconds'], 600)
        self.assertEqual(state['status'], 'SKIPPED client-asleep')
        self.assertEqual(code, 0)
        self.assertEqual(len(self.urls), 2)
        self.assertFalse(self.notices())

    def test_old_sleep_or_darkwake_does_not_hide_remote_failure(self):
        self.failed = True
        for kind in ('Sleep', 'DarkWake'):
            self.power = f'2000-01-01 00:00:00 +0000 {kind}                 stale transition'
            self.assertEqual(self.invoke()[1]['status'], 'FAIL')
        self.assertEqual(self.notices().count('runtime FAIL'), 1)

    def test_continuous_skips_notify_once_until_a_real_check(self):
        self.offline = True
        self.invoke()
        state_file = self.probe.STATE / 'last.json'
        state = json.loads(state_file.read_text())
        state['skip_since'] = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=3)).isoformat()
        state_file.write_text(json.dumps(state))
        self.invoke()
        self.invoke()
        self.assertEqual(self.notices().count('probe skipped continuously'), 1)
        self.offline = False
        self.power = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S %z') + ' DarkWake                 maintenance wake'
        self.invoke()
        self.assertEqual(self.notices().count('probe skipped continuously'), 1)
        self.power = '2000-01-01 00:00:00 +0000 Wake                 full wake'
        self.invoke()
        self.assertNotIn('skip_since', json.loads(state_file.read_text()))

    def test_sleep_event_age_limit_is_configurable(self):
        self.config['sleep_event_max_age_minutes'] = 0
        self.config_path.write_text(json.dumps(self.config))
        self.failed = True
        self.power = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S %z') + ' Sleep                 sleep transition'
        self.assertEqual(self.invoke()[1]['status'], 'FAIL')

    def test_skip_notice_threshold_is_configurable(self):
        self.config['skip_notice_hours'] = 1
        self.config_path.write_text(json.dumps(self.config))
        self.offline = True
        self.invoke()
        state_file = self.probe.STATE / 'last.json'
        state = json.loads(state_file.read_text())
        state['skip_since'] = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=90)).isoformat()
        state_file.write_text(json.dumps(state))
        self.invoke()
        self.assertIn('probe skipped continuously for over 1 hours', self.notices())
        self.invoke()
        self.assertEqual(self.notices().count('probe skipped continuously'), 1)

    def test_host_field_is_not_required(self):
        self.config.pop('host')
        self.config_path.write_text(json.dumps(self.config))
        self.assertTrue(self.invoke()[1]['healthy'])

    def test_outside_writes_are_refused_even_for_a_legacy_global(self):
        outside = self.root.parent / 'forbidden-probe-inbox.md'
        with self.guarded_writes(), self.assertRaisesRegex(AssertionError, 'outside temporary'):
            outside.open('a')
        self.failed = True
        if hasattr(self.probe, 'INBOX'):
            with patch.object(self.probe, 'INBOX', outside):
                with self.assertRaisesRegex(AssertionError, 'outside temporary'):
                    self.invoke()
        else:
            with patch.dict(os.environ, {'NL_PROBE_INBOX': str(outside)}), self.assertRaises(AssertionError):
                self.invoke()
        self.assertFalse(outside.exists())

    def test_public_redirect_is_not_connectivity(self):
        self.head_status = '302'
        self.assertEqual(self.invoke()[1]['status'], 'SKIPPED client-offline')

    def test_remote_error_names_remote_phase(self):
        with patch.object(self.probe, 'http', side_effect=ValueError('malformed response')):
            self.assertIn('remote checks', self.invoke()[1]['checks'])

    def test_dns_alone_does_not_establish_connectivity(self):
        self.head_down = True
        self.assertEqual(self.invoke()[1]['status'], 'SKIPPED client-offline')


if __name__ == '__main__':
    unittest.main()

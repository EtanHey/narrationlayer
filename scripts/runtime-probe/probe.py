#!/usr/bin/env python3
"""Check runtime health only when the client can judge it; notify on transitions."""
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
from urllib.parse import urlsplit, urlunsplit

STATE = Path(os.environ.get('NL_PROBE_STATE_DIR', Path.home() / '.local/state/narrationlayer/probe'))
OVERRIDES = {'app': 'NL_PROBE_APP_URL', 'clip_url': 'NL_PROBE_CLIP_URL',
             'relay_url': 'NL_PROBE_RELAY_URL', 'audio_url': 'NL_PROBE_AUDIO_URL',
             'audio_url_endpoint': 'NL_PROBE_AUDIO_URL_ENDPOINT',
             'inbox_path': 'NL_PROBE_INBOX', 'token_file': 'NL_PROBE_TOKEN_FILE'}


def load_config():
    path = Path(os.environ.get('NL_PROBE_CONFIG', '~/.config/narrationlayer/probe.json')).expanduser()
    config = json.loads(path.read_text())
    for key, env in OVERRIDES.items():
        if env in os.environ:
            config[key] = os.environ[env]
    for key in ('host', 'app', 'clip_url', 'relay_url', 'audio_url'):
        value = urlsplit(config[key])
        if value.scheme != 'https' or not value.hostname or value.username or value.password:
            raise ValueError('invalid URL field')
    app = urlsplit(config['app'])
    config['app'] = urlunsplit((app.scheme, app.netloc, '/', '', ''))
    config.setdefault('audio_url_endpoint', config['app'] + 'api/audio-url')
    if urlsplit(config['audio_url_endpoint']).scheme != 'https':
        raise ValueError('invalid audio endpoint')
    if not all(isinstance(config[k], str) and config[k].strip() for k in ('inbox_path', 'token_file')):
        raise ValueError('missing path')
    if not isinstance(config['launchd_labels'], list) or not config['launchd_labels'] or not all(
            isinstance(label, str) and label for label in config['launchd_labels']):
        raise ValueError('missing launchd labels')
    if type(config['funnel_port']) is not int or not 1 <= config['funnel_port'] <= 65535:
        raise ValueError('invalid port')
    config['wake_grace_minutes'] = float(config.get('wake_grace_minutes', 5))
    if not math.isfinite(config['wake_grace_minutes']) or config['wake_grace_minutes'] < 0:
        raise ValueError('invalid grace period')
    return config


def run(args, stdin=None):
    try:
        result = subprocess.run(args, input=stdin, text=True, capture_output=True, timeout=20)
        return result.returncode, result.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 1, ''


def http(url, expected, ranged=False, authenticated=False, token_file=None):
    args = ['/usr/bin/curl', '--silent', '--show-error', '--output', '/dev/null',
            '--write-out', '%{http_code}', '--max-time', '15']
    if ranged:
        args += ['--header', 'Range: bytes=0-0']
    config = None
    if authenticated:
        try:
            token = Path(token_file).expanduser().read_text().strip()
            if not token or '\n' in token or '\r' in token:
                return 'token unavailable or invalid'
            config = 'header = "Authorization: Bearer ' + token.replace('\\', '\\\\').replace('"', '\\"') + '"\n'
            args += ['--config', '-']
        except OSError:
            return 'token unavailable or invalid'
    code, output = run(args + [url], config)
    return None if code == 0 and output == str(expected) else f'expected HTTP {expected}, got {output if re.fullmatch(r"[0-9]{3}", output) else "request error"}'


def check_jobs(jobs):
    failures = []
    for job in jobs:
        code, output = run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/{job}'])
        if code or not re.search(r'^\s*pid = [1-9][0-9]*\s*$', output, re.MULTILINE):
            failures.append(job)
    return ', '.join(failures) if failures else None


def check_funnel(config):
    code, output = run([config.get('tailscale_command', 'tailscale'), 'serve', 'status', '--json'])
    try:
        funnel = json.loads(output)
        enabled = [key for key, value in funnel.get('AllowFunnel', {}).items() if value is True]
        if code == 0 and len(enabled) == 1 and enabled[0].endswith(':' + str(config['funnel_port'])):
            return None
    except (ValueError, AttributeError, TypeError):
        pass
    return 'AllowFunnel port mismatch or status unavailable'


def client_health(config, now):
    evidence = {}
    for host in ('www.apple.com', 'www.cloudflare.com'):
        try:
            dns = bool(socket.getaddrinfo(host, 443))
        except OSError:
            dns = False
        code, status = run(['/usr/bin/curl', '--head', '--silent', '--output', '/dev/null',
                            '--write-out', '%{http_code}', '--max-time', '10', 'https://' + host])
        evidence[host] = {'dns': dns, 'head': code == 0 and status.startswith(('2', '3'))}
    code, log = run(['/usr/bin/pmset', '-g', 'log'])
    events = re.findall(r'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})\s+(Sleep|DarkWake|Wake)\s', log, re.M)
    evidence['power'] = 'unavailable'
    asleep = False
    if code == 0 and events:
        stamp, kind = events[-1]
        age = (now - datetime.datetime.strptime(stamp, '%Y-%m-%d %H:%M:%S %z')).total_seconds()
        evidence['power'] = {'event': kind, 'time': stamp, 'age_seconds': age}
        asleep = kind in ('Sleep', 'DarkWake') or age < config['wake_grace_minutes'] * 60
    if asleep:
        return 'SKIPPED client-asleep', evidence
    if not any(item['dns'] and item['head'] for host, item in evidence.items() if host != 'power'):
        return 'SKIPPED client-offline', evidence
    if code != 0 or not events:
        raise ValueError('power history unavailable')
    return None, evidence


def main():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / 'probe.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        last = STATE / 'last.json'
        try:
            previous = json.loads(last.read_text())
            if not isinstance(previous, dict):
                previous = {}
        except (OSError, ValueError):
            previous = {}
        old_status = previous.get('last_status')
        if old_status is None and isinstance(previous.get('healthy'), bool):
            old_status = 'HEALTHY' if previous['healthy'] else 'FAIL'
        # The independent env route still works when the JSON cannot be read.
        inbox_path = os.environ.get('NL_PROBE_INBOX') or previous.get('inbox_path') or str(STATE / 'inbox.md')
        now = datetime.datetime.now(datetime.timezone.utc)
        state = {'time': now.isoformat(), 'checks': {}, 'healthy': None}
        phase = 'configuration'
        try:
            config = load_config()
            inbox_path = config['inbox_path']
            phase = 'client power history'
            status, state['client'] = client_health(config, now)
            if status is None:
                state['checks'] = {
                    'clip': http(config['clip_url'], 206, ranged=True),
                    'relay': http(config['relay_url'], 206, ranged=True, authenticated=True, token_file=config['token_file']),
                    'lakebed': http(config['app'], 200),
                    'audio_unauthenticated': http(config['audio_url'], 401),
                    'audio_url_unauthenticated': http(config['audio_url_endpoint'], 401),
                    'launchd': check_jobs(config['launchd_labels']), 'funnel': check_funnel(config),
                }
                state['healthy'] = not any(state['checks'].values())
                status = 'HEALTHY' if state['healthy'] else 'FAIL'
        except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError) as error:
            status = 'CONFIG-ERROR'
            state['checks'] = {phase: f'{type(error).__name__}: check external config and pmset access'}
        state.update(status=status, inbox_path=inbox_path)
        if status.startswith('SKIPPED'):
            state['last_status'] = old_status
        else:
            if status != old_status and (status != 'HEALTHY' or old_status in ('FAIL', 'CONFIG-ERROR')):
                notice = 'RECOVERY' if status == 'HEALTHY' else status
                lines = ''.join(f'- {key}: {value}\n' for key, value in state['checks'].items() if value)
                with Path(inbox_path).expanduser().open('a') as inbox:
                    fcntl.flock(inbox, fcntl.LOCK_EX)
                    inbox.write(f'\n### narrationlayer-probe → @orc @narrationlayer: dashboard runtime {notice} ({state["time"]})\n{lines or "- All checks healthy."}\n')
                    inbox.flush()
                    os.fsync(inbox.fileno())
            state['last_status'] = status
        with tempfile.NamedTemporaryFile(mode='w', dir=STATE, delete=False) as tmp:
            json.dump(state, tmp, indent=2)
            tmp.write('\n')
            name = tmp.name
        os.replace(name, last)
        print(json.dumps(state))
        return 1 if status in ('FAIL', 'CONFIG-ERROR') else 0


if __name__ == '__main__':
    raise SystemExit(main())

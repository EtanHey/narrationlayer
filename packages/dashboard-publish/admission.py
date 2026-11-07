"""Public, network-free publisher admission. Runtime probes are supplied by the host."""
import hashlib
import json
import os
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit, parse_qs

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent
LIMIT = 1024 * 1024


class Refusal(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise Refusal(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate(value, name, code):
    schema = json.loads((ROOT / (name + '.schema.json')).read_text())
    require(Draft202012Validator(schema, format_checker=FormatChecker()).is_valid(value), code)


class Scope(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.ids, self.storage, self.scripts = [], [], []
        self.script = None
        self.feed(html.decode('utf8'))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta' and attrs.get('name') == 'dashboard-id': self.ids.append(attrs.get('content'))
        if tag == 'body': self.storage.append(attrs.get('data-storage-key'))
        if tag == 'script': self.script = ''

    def handle_data(self, data):
        if self.script is not None: self.script += data

    def handle_endtag(self, tag):
        if tag == 'script' and self.script is not None:
            self.scripts.append(self.script)
            self.script = None


def check_lock(lock, owner_pid):
    try:
        pid = json.loads((Path(lock) / 'owner.json').read_text())['pid']
        require(type(pid) is int and pid == owner_pid and pid > 0, 'DEPLOY_LOCK')
        ancestor = os.getpid()
        for _ in range(8):
            if ancestor == pid: break
            result = subprocess.run(['ps', '-o', 'ppid=', '-p', str(ancestor)], capture_output=True, text=True)
            ancestor = int(result.stdout.strip() or '0')
            if ancestor <= 1: break
        require(ancestor == pid, 'DEPLOY_LOCK')
        os.kill(pid, 0)
    except (OSError, ValueError, KeyError, TypeError):
        raise Refusal('DEPLOY_LOCK') from None


def admit(*, handoff, raw, shell, dashboard_id, saved_keys, deliveries, provider, artifact, lock, owner_pid):
    require(handoff is not None, 'HANDOFF_MISSING')
    validate(handoff, 'publish-handoff', 'HANDOFF_SCHEMA')
    require(re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', dashboard_id) and len(dashboard_id) <= 96
            and dashboard_id == handoff['dashboardId'], 'DASHBOARD_ID')
    require(sha(raw) == handoff['sourceHtmlSha256'], 'SOURCE_SHA')  # Prepared input, never builtHtmlSha256.
    for html in (raw, shell):
        scope = Scope(html)
        require(scope.ids == [dashboard_id] and scope.storage == ['dbx:' + dashboard_id], 'DASHBOARD_ID')
    history = deliveries.get(handoff['design']['lineage'], [])
    require(not (handoff['design']['admission'] == 'FIRST_IN_LINEAGE'
                 and any(row.get('accepted') is True for row in history)), 'LINEAGE_EXISTS')
    require(handoff['answerPersistence'] == 'PASS', 'ANSWER_PERSISTENCE')
    keys = {row['key']: row['kind'] for row in handoff['answerKeys']}
    require(len(keys) == len(handoff['answerKeys']) and all(
        keys.get(row['key']) == row['kind'] for row in saved_keys), 'ANSWER_IDENTITY')
    require(any(all(token in script for token in ('__answerStore', '.load(', '.save(', '.onStatus('))
                for script in scope.scripts) and provider.get('providerReady') is True
            and provider.get('servedShellSha256') == sha(shell), 'PROVIDER_NOT_READY')
    require(provider.get('savedSemantics') == 'serverAck', 'SAVED_LOCAL_ONLY')
    require(len(artifact) <= LIMIT, 'ARTIFACT_TOO_LARGE')
    check_lock(lock, owner_pid)
    return {'design': handoff['design']['admission'], 'answerIdentity': 'PASS', 'providerReady': True, 'gateVersion': '2',
            'dashboardId': dashboard_id, 'sourceHtmlSha256': sha(raw), 'servedShellSha256': sha(shell)}


def delivery(*, path, shell, artifact, url, approved_origins, existing_rows,
             handoff=None, admission=None, staging=None, backfill=None):
    if backfill is not None:
        require(handoff is None and staging is None and admission is None, 'BACKFILL_INPUT')
        dashboard_id, source_sha = backfill['dashboardId'], backfill['sourceHtmlSha256']
        proof = backfill['accountProof']
        require(sha(backfill['sourceHtml']) == source_sha, 'SOURCE_SHA')
        stage = {'mode': 'none-backfill', 'servedShellSha256': sha(shell)}
        echo = {'design': 'UNKNOWN_BACKFILL', 'answerIdentity': 'PASS', 'providerReady': True, 'gateVersion': '2'}
    else:
        require(handoff is not None and admission is not None and isinstance(staging, dict), 'STAGING_PROOF')
        validate(handoff, 'publish-handoff', 'HANDOFF_SCHEMA')
        require(staging.get('mode') == 'unlisted-candidate'
                and staging.get('servedShellSha256') == sha(shell) == admission.get('servedShellSha256')
                and admission.get('sourceHtmlSha256') == handoff['sourceHtmlSha256']
                and admission.get('dashboardId') == handoff['dashboardId']
                and admission.get('design') == handoff['design']['admission'], 'STAGING_PROOF')
        dashboard_id, source_sha = handoff['dashboardId'], handoff['sourceHtmlSha256']
        proof = staging.get('accountProof', {})
        stage = {key: staging[key] for key in ('mode', 'servedShellSha256')}
        echo = {key: admission.get(key) for key in ('design', 'answerIdentity', 'providerReady', 'gateVersion')}
    parsed = urlsplit(url)
    require(parsed.scheme == 'https' and not parsed.username and not parsed.password
            and parsed.scheme + '://' + parsed.netloc in approved_origins
            and parse_qs(parsed.query).get('d') == [dashboard_id], 'DELIVERY_ORIGIN')
    require(proof.get('existingRowsPreserved') == existing_rows, 'STAGING_PROOF')
    value = {'schema': 'audio-dashboard.delivery.v2', 'host': 'lakebed', 'url': url,
        'dashboardId': dashboard_id, 'sourceHtmlSha256': source_sha,
        'servedShellSha256': sha(shell), 'artifactSha256': sha(artifact),
        'staging': stage, 'accountProof': proof, 'admission': echo,
        'publishedAt': datetime.now(timezone.utc).isoformat()}
    if backfill is not None: value['backfilled'] = True
    validate(value, 'delivery', 'STAGING_PROOF')
    with Path(path).open('x') as stream: stream.write(json.dumps(value, indent=2) + '\n')
    return value

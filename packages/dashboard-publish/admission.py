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


def validator(schema):
    checker = FormatChecker()
    require({'date-time', 'uri'} <= checker.checkers.keys(), 'FORMAT_VALIDATORS')
    return Draft202012Validator(schema, format_checker=checker)


def validate(value, name, code):
    schema = json.loads((ROOT / (name + '.schema.json')).read_text())
    require(validator(schema).is_valid(value), code)


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


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', value) and len(value) <= 96


def check_scope(html, dashboard_id):
    scope = Scope(html)
    require(scope.ids == [dashboard_id] and scope.storage == ['dbx:' + dashboard_id], 'DASHBOARD_ID')
    return scope


def read_prepared_index(source):
    source = Path(source)
    index = source / 'index.html'
    require(not index.is_symlink() and index.resolve().is_relative_to(source.resolve()), 'SOURCE_PATH')
    return index.read_bytes()


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


def runtime_sha(html):
    blocks = re.findall(r'\(function installAnswerPersistence\(\) \{.*?\n\}\)\(\);', html.decode('utf8'), re.S)
    require(len(blocks) == 1, 'ANSWER_RUNTIME_BLOCK')
    return sha(blocks[0].strip().encode())


def runtime_status(digest, config):
    try:
        entries = json.loads(Path(config).read_text())
        require(isinstance(entries, list) and all(isinstance(row, dict) and
                re.fullmatch('[a-f0-9]{64}', row.get('sha256', '')) and row.get('status') in ('current', 'deprecated')
                and isinstance(row.get('note'), str) for row in entries), 'ANSWER_RUNTIME_CONFIG')
        matches = [row for row in entries if row['sha256'] == digest]
        require(len(matches) == 1, 'ANSWER_RUNTIME_NOT_ALLOWED')
        return matches[0]['status']
    except (OSError, ValueError, TypeError) as error:
        if isinstance(error, Refusal): raise
        raise Refusal('ANSWER_RUNTIME_CONFIG') from None


def validate_deliveries(deliveries):
    require(isinstance(deliveries, dict) and all(isinstance(rows, list) and all(isinstance(row, dict) for row in rows)
            for rows in deliveries.values()), 'DELIVERIES_SCHEMA')
    return deliveries


def check_staging(staging, design, dashboard_id, deliveries, served_shell_sha256):
    mode = staging.get('mode') if isinstance(staging, dict) else None
    require(mode in ('unlisted-candidate', 'in-place-maintenance', 'none-backfill'), 'INVALID_STAGING_MODE')
    require(mode != 'none-backfill', 'STAGING_MODE')
    accepted = [row for rows in deliveries.values() for row in rows if row.get('accepted') is True and row.get('dashboardId') == dashboard_id]
    require(mode != 'unlisted-candidate' or not accepted, 'MAINTENANCE_REQUIRED')
    if mode == 'in-place-maintenance':
        previous = staging.get('previousServedShellSha256')
        require(isinstance(previous, str) and re.fullmatch('[a-f0-9]{64}', previous) and previous != served_shell_sha256, 'MAINTENANCE_PREVIOUS_SHELL')
        require(design in ('COMPARED', 'REDESIGN_APPROVED'), 'MAINTENANCE_DESIGN')
        require(bool(accepted), 'MAINTENANCE_NOT_ACCEPTED')
        recorded = accepted[-1].get('servedShellSha256')
        require(recorded is None or recorded == previous, 'MAINTENANCE_PREVIOUS_SHELL')


def recorded_approval(approval):
    return (isinstance(approval, dict) and all(isinstance(approval.get(field), str)
        and approval[field].strip() and not re.search(r'[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]', approval[field])
        for field in ('reason', 'approvedBy')) and approval['approvedBy'].strip().upper() != 'UNRECORDED')


def admit(*, handoff, raw, shell, dashboard_id, saved_keys, deliveries, provider, artifact, lock, owner_pid, runtime_config=ROOT / "answer-runtimes.json", staging=None):
    require(handoff is not None, 'HANDOFF_MISSING')
    design = handoff.get('design', {}) if isinstance(handoff, dict) else {}
    if isinstance(design, dict) and design.get('admission') == 'FIRST_IN_LINEAGE':
        require(recorded_approval(design.get('firstInLineage')), 'FIRST_IN_LINEAGE_UNAPPROVED')
    if isinstance(design, dict) and design.get('admission') == 'REDESIGN_APPROVED':
        require(recorded_approval(design.get('redesign')), 'REDESIGN_UNAPPROVED')
    validate(handoff, 'publish-handoff', 'HANDOFF_SCHEMA')
    require(valid_id(dashboard_id) and dashboard_id == handoff['dashboardId'], 'DASHBOARD_ID')
    require(sha(raw) == handoff['sourceHtmlSha256'], 'SOURCE_SHA')  # Prepared input, never builtHtmlSha256.
    for html in (raw, shell):
        scope = check_scope(html, dashboard_id)
    deliveries = validate_deliveries(deliveries)
    history = deliveries.get(handoff['design']['lineage'], [])
    self_accepted = any(row.get('accepted') is True and row.get('dashboardId') == dashboard_id
                        and row.get('sourceHtmlSha256') == handoff['sourceHtmlSha256'] for row in history)
    require(handoff['design']['admission'] != 'FIRST_IN_LINEAGE' or self_accepted
            or not any(row.get('accepted') is True for row in history), 'LINEAGE_EXISTS')
    if staging is not None: check_staging(staging, handoff['design']['admission'], dashboard_id, deliveries, sha(shell))
    require(handoff['answerPersistence'] == 'PASS', 'ANSWER_PERSISTENCE')
    digest = handoff['answerRuntimeSha256']
    require(runtime_sha(raw) == runtime_sha(shell) == digest, 'ANSWER_RUNTIME_MISMATCH')
    status = runtime_status(digest, runtime_config)
    require(status != 'deprecated' or any(row.get('accepted') is True and row.get('dashboardId') == dashboard_id
            for rows in deliveries.values() for row in rows), 'ANSWER_RUNTIME_DEPRECATED_NEW')
    keys = {row['key']: row['kind'] for row in handoff['answerKeys']}
    require(len(keys) == len(handoff['answerKeys']) and all(
        keys.get(row['key']) == row['kind'] for row in saved_keys), 'ANSWER_IDENTITY')
    require(any(all(token in script for token in ('__answerStore', '.load(', '.save(', '.onStatus('))
                for script in scope.scripts) and provider.get('providerReady') is True
            and provider.get('servedShellSha256') == sha(shell), 'PROVIDER_NOT_READY')
    require(provider.get('savedSemantics') == 'serverAck', 'SAVED_LOCAL_ONLY')
    require(len(artifact) <= LIMIT, 'ARTIFACT_TOO_LARGE')
    check_lock(lock, owner_pid)
    return {'answerRuntime': status, 'design': handoff['design']['admission'], 'answerIdentity': 'PASS', 'providerReady': True, 'gateVersion': '2',
            'dashboardId': dashboard_id, 'sourceHtmlSha256': sha(raw), 'servedShellSha256': sha(shell)}


def delivery(*, path, shell, artifact, url, approved_origins, existing_rows,
             handoff=None, admission=None, staging=None, backfill=None, runtime_config=ROOT / "answer-runtimes.json", deliveries=None):
    deliveries = validate_deliveries(deliveries) if backfill is None or deliveries is not None else {}
    if backfill is not None:
        require(isinstance(backfill, dict) and {'dashboardId', 'sourceHtmlSha256', 'sourceHtml', 'accountProof', 'answerIdentity', 'providerReady'} <= backfill.keys(), 'BACKFILL_INPUT')
        require(handoff is None and staging is None and admission is None, 'BACKFILL_INPUT')
        require(isinstance(backfill.get('sourceHtml'), bytes), 'BACKFILL_INPUT')
        dashboard_id, source_sha = backfill['dashboardId'], backfill['sourceHtmlSha256']
        require(valid_id(dashboard_id), 'DASHBOARD_ID')
        for html in (backfill['sourceHtml'], shell): check_scope(html, dashboard_id)
        require(backfill.get('answerIdentity') == 'PASS' and backfill.get('providerReady') is True, 'BACKFILL_OBSERVATIONS')
        proof = backfill.get('accountProof')
        require(sha(backfill['sourceHtml']) == source_sha, 'SOURCE_SHA')
        stage = {'mode': 'none-backfill', 'servedShellSha256': sha(shell)}
        echo = {'answerRuntime': runtime_status(runtime_sha(shell), runtime_config), 'design': 'UNKNOWN_BACKFILL', 'answerIdentity': backfill['answerIdentity'], 'providerReady': backfill['providerReady'], 'gateVersion': '2'}
    else:
        require(handoff is not None and admission is not None and isinstance(staging, dict), 'STAGING_PROOF')
        validate(handoff, 'publish-handoff', 'HANDOFF_SCHEMA')
        check_staging(staging, handoff['design']['admission'], handoff['dashboardId'], deliveries, sha(shell))
        require(staging.get('servedShellSha256') == sha(shell), 'STAGING_SHELL')
        require(admission.get('servedShellSha256') == staging['servedShellSha256'], 'ADMISSION_SHELL')
        require(admission.get('sourceHtmlSha256') == handoff['sourceHtmlSha256'], 'ADMISSION_SOURCE')
        require(admission.get('dashboardId') == handoff['dashboardId'], 'ADMISSION_ID')
        require(admission.get('design') == handoff['design']['admission'], 'ADMISSION_DESIGN')
        require(runtime_status(runtime_sha(shell), runtime_config) == admission.get('answerRuntime'), 'ANSWER_RUNTIME_ECHO')
        dashboard_id, source_sha = handoff['dashboardId'], handoff['sourceHtmlSha256']
        proof = staging.get('accountProof', {})
        stage = {key: staging[key] for key in ('mode', 'servedShellSha256')}
        if staging['mode'] == 'in-place-maintenance': stage['previousServedShellSha256'] = staging['previousServedShellSha256']
        echo = {key: admission.get(key) for key in ('design', 'answerIdentity', 'providerReady', 'answerRuntime', 'gateVersion')}
    parsed = urlsplit(url)
    require(parsed.scheme == 'https' and not parsed.username and not parsed.password
            and parsed.scheme + '://' + parsed.netloc in approved_origins
            and parse_qs(parsed.query).get('d') == [dashboard_id], 'DELIVERY_ORIGIN')
    proof_schema = json.loads((ROOT / 'delivery.schema.json').read_text())['oneOf'][0]['properties']['accountProof']
    require(validator(proof_schema).is_valid(proof), 'ACCOUNT_PROOF')
    require(type(existing_rows) is int and existing_rows >= 0
            and proof['existingRowsPreserved'] == existing_rows, 'ACCOUNT_PROOF')
    value = {'schema': 'audio-dashboard.delivery.v2', 'host': 'lakebed', 'url': url,
        'dashboardId': dashboard_id, 'sourceHtmlSha256': source_sha,
        'servedShellSha256': sha(shell), 'artifactSha256': sha(artifact),
        'staging': stage, 'accountProof': proof, 'admission': echo,
        'publishedAt': datetime.now(timezone.utc).isoformat()}
    if backfill is not None: value['backfilled'] = True
    validate(value, 'delivery', 'DELIVERY_SCHEMA')
    with Path(path).open('x') as stream: stream.write(json.dumps(value, indent=2) + '\n')
    return value

"""Public, network-free publisher admission. Runtime probes are supplied by the host."""
import hashlib
import json
import os
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit, parse_qs, unquote
from xml.etree import ElementTree

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent
LIMIT = 1024 * 1024


class Refusal(ValueError):
    def __init__(self, code, detail=None):
        self.code, self.detail = code, detail
        super().__init__(code)


def require(condition, code, detail=None):
    if not condition:
        raise Refusal(code, detail)


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
        self.ids, self.storage, self.scripts, self.elements = [], [], [], []
        self.script = None
        self.feed(html.decode('utf8'))

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, attrs))  # every attribute pair, duplicates included
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


def runtime_entry(digest, config):
    try:
        entries = json.loads(Path(config).read_text())
        require(isinstance(entries, list) and all(isinstance(row, dict) and
                re.fullmatch('[a-f0-9]{64}', row.get('sha256', '')) and row.get('status') in ('current', 'deprecated')
                and isinstance(row.get('note'), str) and isinstance(row.get('consumerMarkers'), list)
                and row['consumerMarkers'] and all(isinstance(marker, str) and marker.strip()
                    for marker in row['consumerMarkers']) for row in entries), 'ANSWER_RUNTIME_CONFIG')
        matches = [row for row in entries if row['sha256'] == digest]
        require(len(matches) == 1, 'ANSWER_RUNTIME_NOT_ALLOWED')
        return matches[0]
    except (OSError, ValueError, TypeError) as error:
        if isinstance(error, Refusal): raise
        raise Refusal('ANSWER_RUNTIME_CONFIG') from None


def runtime_status(digest, config):
    return runtime_entry(digest, config)['status']


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


# Media a page may carry. A row without `kind` is an mp3 row: every handoff written before kinds existed.
MEDIA_EXTENSIONS = {'mp3': ('mp3',), 'webp': ('webp',), 'png': ('png',), 'jpeg': ('jpg', 'jpeg'), 'svg': ('svg',)}
# mp3 keeps the capsule's existing 5 MiB clip cap. A phone-width image (1170 px at 3x) is 100-400 KB as webp or
# jpeg, so 2 MiB is headroom for a png diagram, not for a raw screenshot. An svg is text and is scanned in full.
MEDIA_LIMITS = {'mp3': 5 * 1024 * 1024, 'webp': 2 * 1024 * 1024, 'png': 2 * 1024 * 1024, 'jpeg': 2 * 1024 * 1024, 'svg': 256 * 1024}
# 200 matches the capsule's per-page audio manifest cap (the largest real page has 124 clips). Each image costs one
# signed-URL request as it nears the viewport; 40 phone-width images is about 12 MB on a cellular link.
MEDIA_PER_PAGE, IMAGES_PER_PAGE = 200, 40
MAGIC = {'png': lambda b: b.startswith(b'\x89PNG\r\n\x1a\n'), 'jpeg': lambda b: b.startswith(b'\xff\xd8\xff'),
         'webp': lambda b: b[:4] == b'RIFF' and b[8:12] == b'WEBP',
         'mp3': lambda b: b.startswith(b'ID3') or (len(b) > 1 and b[0] == 0xff and b[1] & 0xe0 == 0xe0)}
SVG_NS = '{http://www.w3.org/2000/svg}'


def check_svg(data):
    """An svg is only ever shown through <img> (MEDIA_REFERENCE enforces it); refuse script, handlers and references anyway."""
    try: text = data.decode('utf8')
    except UnicodeDecodeError: raise Refusal('MEDIA_SVG_UNSAFE') from None
    lowered = text.lower()
    require('<!doctype' not in lowered and '<!entity' not in lowered and '<?' not in re.sub(r'^\s*<\?xml\s[^?]*\?>', '', lowered), 'MEDIA_SVG_UNSAFE')
    try: root = ElementTree.fromstring(text)
    except ElementTree.ParseError: raise Refusal('MEDIA_SVG_UNSAFE') from None
    require(root.tag in ('svg', SVG_NS + 'svg'), 'MEDIA_SVG_UNSAFE')
    styles = [value for element in root.iter() for value in [element.get('style') or ''] + ([element.text or ''] if element.tag.rsplit('}', 1)[-1] == 'style' else [])]
    # No CSS escape or comment can exist, so the literal checks below see every url(, @rule and scheme as written.
    # The XML parser has already decoded entities (&#117;rl( is url( here). The only at-rule allowed is @media.
    values = styles + [value for element in root.iter() for value in element.attrib.values()]
    require(not any('\\' in value or '/*' in value for value in values), 'MEDIA_SVG_UNSAFE')
    require(all(rule.lower() == 'media' for style in styles for rule in re.findall(r'@([A-Za-z-]*)', style)), 'MEDIA_SVG_UNSAFE')
    for element in root.iter():
        require(element.tag.rsplit('}', 1)[-1].lower() not in ('script', 'foreignobject', 'iframe', 'embed', 'object'), 'MEDIA_SVG_UNSAFE')
        for name, value in element.attrib.items():
            local = name.rsplit('}', 1)[-1].lower()
            require(not local.startswith('on') and (local not in ('href', 'src') or value.strip().startswith('#')), 'MEDIA_SVG_UNSAFE')
            require(not re.search(r'url\(\s*["\']?\s*(?!#)', value, re.I), 'MEDIA_SVG_UNSAFE')
    require(not any(re.search(r'@import|javascript:|url\(\s*["\']?\s*(?!#)', style, re.I) for style in styles), 'MEDIA_SVG_UNSAFE')


VISUAL_FORBIDDEN = {'applet', 'audio', 'embed', 'frame', 'iframe', 'object', 'source', 'track', 'video'}
ANSWER_ATTRIBUTES = {'data-note', 'data-decision'}  # every answering template card carries both; no visual page needs them


def spelled(value):
    """Every spelling of a path as one: percent-decoded to a fixed point, then case-folded."""
    previous = None
    while value != previous: previous, value = value, unquote(value)
    return value.casefold()


def served_clip(value, clips):
    """A served clip URL names a file by its path's end; a query or fragment does not change which file it is."""
    path = urlsplit(value).path
    return any(path.endswith('/' + clip) for clip in clips)


def check_markup(handoff, html, served=False):
    """The page's parsed markup, not its text: what a visual page may contain, and how media may be referenced.

    Every attribute value that mentions assets/ in any spelling (percent-encoded, any case) must be, exactly, a
    manifest file in its one allowed place: an image only as <img data-nl-media>, a clip only as an <audio>/<source>
    src (the served shell of an audio page carries clips as URLs whose path ends in the file). Every manifest image
    must be referenced. No page may carry <base>, which would re-point every relative URL. What a page's script does
    at run time is not judged here: the host refuses answers and audio for a visual page (capsule tests).
    """
    rows, visual = handoff['mediaManifest'], handoff['type'] == 'visual'
    images = {row['file'] for row in rows if row.get('kind', 'mp3') != 'mp3'}
    clips = {row['file'] for row in rows if row.get('kind', 'mp3') == 'mp3'}
    referenced = set()
    for tag, attrs in Scope(html).elements:
        require(tag != 'base', 'MEDIA_REFERENCE', 'base')
        if visual:
            require(tag not in VISUAL_FORBIDDEN, 'VISUAL_MARKUP', tag)
            require(not ANSWER_ATTRIBUTES & {name for name, _ in attrs}, 'VISUAL_ANSWERS', tag)
        for name, value in attrs:
            if value is None or 'assets/' not in spelled(value): continue
            image = tag == 'img' and name == 'data-nl-media' and value in images
            clip = tag in ('audio', 'source') and name == 'src' and (value in clips or served and served_clip(value, clips))
            require(image or clip, 'MEDIA_REFERENCE', value[:120])
            referenced.add(value)
    require(images <= referenced, 'MEDIA_REFERENCE', 'unreferenced image')


def check_media(handoff, media=None):
    """Manifest rules always; byte rules for every row whose bytes are supplied. An svg row needs its bytes."""
    rows, visual = handoff['mediaManifest'], handoff['type'] == 'visual'
    kinds = [row.get('kind', 'mp3') for row in rows]
    require(len(rows) <= MEDIA_PER_PAGE and sum(kind != 'mp3' for kind in kinds) <= IMAGES_PER_PAGE, 'MEDIA_COUNT')
    require(len({row['file'] for row in rows}) == len(rows), 'MEDIA_KIND')
    for row, kind in zip(rows, kinds):
        require(not (visual and kind == 'mp3'), 'VISUAL_AUDIO')
        require(re.fullmatch(r'assets/[A-Za-z0-9_-]+\.(%s)' % '|'.join(MEDIA_EXTENSIONS[kind]), row['file']), 'MEDIA_KIND')
        require(row['size'] <= MEDIA_LIMITS[kind], 'MEDIA_TOO_LARGE')
        data = (media or {}).get(row['file'])
        require(data is not None or kind != 'svg', 'MEDIA_SVG_UNCHECKED')
        if data is None: continue
        require(len(data) == row['size'] and sha(data) == row['sha256'], 'MEDIA_BYTES')
        if kind == 'svg': check_svg(data)
        else: require(MAGIC[kind](data), 'MEDIA_BYTES')


MIME = {'webp': 'image/webp', 'png': 'image/png', 'jpeg': 'image/jpeg', 'svg': 'image/svg+xml'}


def check_visual_proof(proof, handoff, shell):
    """A visual page's delivery proof. Each condition refuses with its own code, so a failed proof names its part."""
    images = {row['file']: row for row in handoff['mediaManifest']}
    renders = sorted(proof['renders'], key=lambda render: render['width'])
    # The client hashes the shell it assembled; equal to the served shell, the render was of exactly these bytes.
    require([render['width'] for render in renders] == [390, 1280] and all(
        render['dashboardId'] == handoff['dashboardId'] and render['shellSha256'] == sha(shell)
        and set(render['imagesLoaded']) == set(images) for render in renders), 'VISUAL_PROOF_RENDER')
    media = {row['file']: row for row in proof['media']}
    require(set(media) == set(images) and len(media) == len(proof['media']), 'VISUAL_PROOF_MEDIA_STATUS')
    for name, row in images.items():
        seen = media[name]
        require(seen['status'] == 200 and re.fullmatch(r'[a-z0-9-]+\.ufs\.sh', seen['loadedFrom']), 'VISUAL_PROOF_MEDIA_STATUS')
        require(seen['contentType'].split(';')[0].strip().lower() == MIME[row['kind']], 'VISUAL_PROOF_MEDIA_TYPE')
        require(seen['sha256'] == row['sha256'] and seen['bytes'] == row['size'], 'VISUAL_PROOF_MEDIA_BYTES')
    require(proof['answerRowsAfter'] == 0, 'VISUAL_PROOF_ANSWER_ROWS')
    require(proof['signedOut'] == {'request': 'media' if images else 'page', 'status': 401}, 'VISUAL_PROOF_SIGNED_OUT')


def recorded_approval(approval):
    return (isinstance(approval, dict) and all(isinstance(approval.get(field), str)
        and approval[field].strip() and not re.search(r'[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]', approval[field])
        for field in ('reason', 'approvedBy')) and approval['approvedBy'].strip().upper() != 'UNRECORDED')


def admit(*, handoff, raw, shell, dashboard_id, saved_keys, deliveries, provider, artifact, lock, owner_pid, runtime_config=ROOT / "answer-runtimes.json", staging=None, media=None):
    require(handoff is not None, 'HANDOFF_MISSING')
    design = handoff.get('design', {}) if isinstance(handoff, dict) else {}
    # A visual page is a document with no answers: declaring any answer field is a contradiction, not a schema typo.
    require(not (isinstance(handoff, dict) and handoff.get('type') == 'visual' and (handoff.get('answerKeys') or
            {'answerRuntimeSha256', 'answerPersistence'} & handoff.keys())), 'VISUAL_ANSWERS')
    require(not (isinstance(handoff, dict) and handoff.get('type') == 'visual' and isinstance(handoff.get('mediaManifest'), list) and any(
            isinstance(row, dict) and row.get('kind', 'mp3') == 'mp3' for row in handoff['mediaManifest'])), 'VISUAL_AUDIO')
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
    check_media(handoff, media)
    check_markup(handoff, raw); check_markup(handoff, shell, served=True)
    if handoff['type'] == 'visual':
        require(not saved_keys and b'installAnswerPersistence' not in raw + shell, 'VISUAL_ANSWERS')
        require(len(artifact) <= LIMIT, 'ARTIFACT_TOO_LARGE')
        check_lock(lock, owner_pid)
        return {'pageType': 'visual', 'answerRuntime': 'none', 'design': handoff['design']['admission'], 'answerIdentity': 'NOT_APPLICABLE',
                'providerReady': None, 'gateVersion': '2', 'dashboardId': dashboard_id, 'sourceHtmlSha256': sha(raw), 'servedShellSha256': sha(shell)}
    require(handoff['answerPersistence'] == 'PASS', 'ANSWER_PERSISTENCE')
    digest = handoff['answerRuntimeSha256']
    require(runtime_sha(raw) == runtime_sha(shell) == digest, 'ANSWER_RUNTIME_MISMATCH')
    entry = runtime_entry(digest, runtime_config)
    status = entry['status']
    require(status != 'deprecated' or any(row.get('accepted') is True and row.get('dashboardId') == dashboard_id
            for rows in deliveries.values() for row in rows), 'ANSWER_RUNTIME_DEPRECATED_NEW')
    keys = {row['key']: row['kind'] for row in handoff['answerKeys']}
    require(len(keys) == len(handoff['answerKeys']) and all(
        keys.get(row['key']) == row['kind'] for row in saved_keys), 'ANSWER_IDENTITY')
    require(any(all(marker in script for marker in entry['consumerMarkers'])
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
        stage, visual = {'mode': 'none-backfill', 'servedShellSha256': sha(shell)}, False
        echo = {'answerRuntime': runtime_status(runtime_sha(shell), runtime_config), 'design': 'UNKNOWN_BACKFILL', 'answerIdentity': backfill['answerIdentity'], 'providerReady': backfill['providerReady'], 'gateVersion': '2'}
    else:
        require(handoff is not None and admission is not None and isinstance(staging, dict), 'STAGING_PROOF')
        validate(handoff, 'publish-handoff', 'HANDOFF_SCHEMA')
        # An answer page proves an answer round trip; a visual page proves its render. Neither accepts the other's.
        visual = handoff['type'] == 'visual'
        require(isinstance(staging.get('accountProof'), dict) and (staging['accountProof'].get('method') == 'visual-render') == visual, 'PROOF_KIND')
        check_staging(staging, handoff['design']['admission'], handoff['dashboardId'], deliveries, sha(shell))
        require(staging.get('servedShellSha256') == sha(shell), 'STAGING_SHELL')
        require(admission.get('servedShellSha256') == staging['servedShellSha256'], 'ADMISSION_SHELL')
        require(admission.get('sourceHtmlSha256') == handoff['sourceHtmlSha256'], 'ADMISSION_SOURCE')
        require(admission.get('dashboardId') == handoff['dashboardId'], 'ADMISSION_ID')
        require(admission.get('design') == handoff['design']['admission'], 'ADMISSION_DESIGN')
        if visual: require(admission.get('pageType') == 'visual' and admission.get('answerRuntime') == 'none' and b'installAnswerPersistence' not in shell, 'ANSWER_RUNTIME_ECHO')
        else: require(runtime_status(runtime_sha(shell), runtime_config) == admission.get('answerRuntime'), 'ANSWER_RUNTIME_ECHO')
        dashboard_id, source_sha = handoff['dashboardId'], handoff['sourceHtmlSha256']
        proof = staging.get('accountProof', {})
        stage = {key: staging[key] for key in ('mode', 'servedShellSha256')}
        if staging['mode'] == 'in-place-maintenance': stage['previousServedShellSha256'] = staging['previousServedShellSha256']
        echo = {key: admission.get(key) for key in (('pageType', 'design', 'answerRuntime', 'gateVersion') if visual else ('design', 'answerIdentity', 'providerReady', 'answerRuntime', 'gateVersion'))}
    parsed = urlsplit(url)
    require(parsed.scheme == 'https' and not parsed.username and not parsed.password
            and parsed.scheme + '://' + parsed.netloc in approved_origins
            and parse_qs(parsed.query).get('d') == [dashboard_id], 'DELIVERY_ORIGIN')
    schema = json.loads((ROOT / 'delivery.schema.json').read_text())
    proof_schema = schema['oneOf'][2 if visual else 0]['properties']['accountProof']
    require(validator(proof_schema).is_valid(proof), 'ACCOUNT_PROOF')
    require(type(existing_rows) is int and existing_rows >= 0
            and proof['existingRowsPreserved'] == existing_rows, 'ACCOUNT_PROOF')
    if visual: check_visual_proof(proof, handoff, shell)
    value = {'schema': 'audio-dashboard.delivery.v2', 'host': 'lakebed', 'url': url,
        'dashboardId': dashboard_id, 'sourceHtmlSha256': source_sha,
        'servedShellSha256': sha(shell), 'artifactSha256': sha(artifact),
        'staging': stage, 'accountProof': proof, 'admission': echo,
        'publishedAt': datetime.now(timezone.utc).isoformat()}
    if backfill is not None: value['backfilled'] = True
    validate(value, 'delivery', 'DELIVERY_SCHEMA')
    with Path(path).open('x') as stream: stream.write(json.dumps(value, indent=2) + '\n')
    return value

"""Golden admit() results for audio handoffs of the shape written before media kinds existed.

    python3 admission_golden.py <commit> > fixtures/admission-golden.json

loads that commit's admission.py and schemas from git and runs the corpus through it. test_admission_golden.py
runs the same corpus through this checkout's admit(), without the media argument, and compares. Synthetic shapes
only: they mirror the real handoffs (mp3 rows named assets/<name>.mp3, referenced by <audio src>, up to 124 rows
and 662 KB a clip) without copying private content.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME = b'(function installAnswerPersistence() {\n  // fixture runtime\n})();'
CONSUMER = b'<script>const s=window.__answerStore;s.load();s.save();s.onStatus();</script>'
SIZES = [43989, 245973, 51933, 428037, 661989, 21285]


def page(dashboard, clips=(), extra=b''):
    audio = b''.join(b'<audio src="' + name.encode() + b'"></audio>' for name in clips)
    raw = (b'<meta name="dashboard-id" content="' + dashboard.encode() + b'"><body data-storage-key="dbx:' + dashboard.encode() + b'">'
           + audio + extra + b'<script>' + RUNTIME + b'</script>')
    return raw, raw + CONSUMER


def clip_rows(count, size=None, name='clip'):
    return [{'file': 'assets/%s-%d.mp3' % (name, i), 'size': size or SIZES[i % len(SIZES)], 'sha256': '%064x' % (i + 1)} for i in range(count)]


def corpus(root):
    """(name, admit keyword arguments). Lock and runtime config live under root."""
    sha = lambda data: __import__('hashlib').sha256(data).hexdigest()
    config = root / 'runtimes.json'
    config.write_text(json.dumps([{'sha256': sha(RUNTIME), 'status': 'current', 'note': 'fixture', 'consumerMarkers': ['__answerStore', '.load(', '.save(', '.onStatus(']}]))
    lock = root / 'lock'; lock.mkdir(exist_ok=True); (lock / 'owner.json').write_text(json.dumps({'pid': os.getpid()}))

    def case(rows=(), referenced=None, extra=b'', page_type='decision-flow', handoff=None, **changes):
        rows = list(rows)
        raw, shell = page('corpus-1', [r['file'] for r in rows] if referenced is None else referenced, extra)
        value = {'schema': 'audio-dashboard.publish-handoff.v2', 'dashboardId': 'corpus-1', 'type': page_type, 'sourcePath': 'build',
                 'builtHtmlSha256': sha(b'build'), 'answerRuntimeSha256': sha(RUNTIME), 'sourceHtmlSha256': sha(raw), 'buildReceiptsSha256': sha(b'receipts'),
                 'answerPersistence': 'PASS', 'answerKeys': [{'key': 'note', 'kind': 'text'}], 'mediaManifest': rows,
                 'design': {'firstInLineage': {'reason': 'corpus', 'approvedBy': 'corpus-reviewer'}, 'admission': 'FIRST_IN_LINEAGE', 'lineage': 'corpus', 'predecessorSha256': None},
                 'createdAt': '2026-01-01T00:00:00Z'} | (handoff or {})
        args = dict(handoff=value, raw=raw, shell=shell, dashboard_id='corpus-1', saved_keys=[{'key': 'note', 'kind': 'text'}], deliveries={},
                    provider={'providerReady': True, 'servedShellSha256': sha(shell), 'savedSemantics': 'serverAck'},
                    artifact=b'{}', lock=lock, owner_pid=os.getpid(), runtime_config=config)
        return args | changes

    compared = {'design': {'admission': 'COMPARED', 'lineage': 'corpus', 'predecessorSha256': '0' * 64}}
    return [
        ('answers-no-media', case()),
        ('three-clips', case(clip_rows(3))),
        ('a-full-page-of-clips', case(clip_rows(124))),
        ('cinema-clips', case(clip_rows(4), page_type='cinema')),
        ('compared-design', case(clip_rows(2), handoff=compared)),
        ('persistence-fail', case(handoff={'answerPersistence': 'FAIL'})),
        ('identity-mismatch', case(saved_keys=[{'key': 'note', 'kind': 'radio'}])),
        ('lineage-exists', case(deliveries={'corpus': [{'accepted': True}]})),
        ('source-sha', case(handoff={'sourceHtmlSha256': '1' * 64})),
        ('dashboard-id', case(dashboard_id='other')),
        ('provider-not-ready', case(provider={})),
        ('saved-local-only', case(provider={'providerReady': True, 'savedSemantics': 'local'})),
        ('artifact-too-large', case(artifact=b'x' * (1048576 + 1))),
        ('deploy-lock', case(owner_pid=os.getpid() + 1)),
        ('schema-missing-createdAt', case(handoff={'createdAt': None})),
        ('runtime-mismatch', case(handoff={'answerRuntimeSha256': '2' * 64})),
        # Deliberate tightenings (test_admission_golden.TIGHTENED names each one and its reason).
        ('png-row-without-kind', case([{'file': 'assets/a.png', 'size': 10, 'sha256': '3' * 64}], referenced=[])),
        ('clip-row-outside-assets', case([{'file': 'media/a.mp3', 'size': 10, 'sha256': '4' * 64}])),
        ('clip-over-five-mib', case(clip_rows(1, size=5 * 1024 * 1024 + 1))),
        ('two-hundred-and-one-clips', case(clip_rows(201))),
        ('duplicate-clip-name', case(clip_rows(1) * 2)),
        ('clip-linked-outside-audio', case(clip_rows(1), extra=b'<a href="assets/clip-0.mp3">clip</a>')),
        ('assets-path-not-in-manifest', case(clip_rows(1), extra=b'<img src="assets/missing.png">')),
    ]


def run(admission, root):
    results = {}
    for name, args in corpus(root):
        try: result = admission.admit(**args)
        except admission.Refusal as error: result = {'refusal': error.code}
        results[name] = result
    return results


def at_commit(commit, directory):
    """Write that commit's package files the admission module reads, and import it under its own name."""
    for name in ('admission.py', 'publish-handoff.schema.json', 'delivery.schema.json', 'answer-runtimes.json'):
        data = subprocess.check_output(['git', '-C', str(ROOT), 'show', commit + ':packages/dashboard-publish/' + name])
        (Path(directory) / name).write_bytes(data)
    spec = importlib.util.spec_from_file_location('admission_at_' + commit[:12], Path(directory) / 'admission.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as code, tempfile.TemporaryDirectory() as root:
        admission = at_commit(sys.argv[1], code)
        print(json.dumps({'commit': sys.argv[1], 'results': run(admission, Path(root))}, indent=1, sort_keys=True))

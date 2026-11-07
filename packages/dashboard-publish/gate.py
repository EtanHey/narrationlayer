"""JSON stdin adapter; callers pass the exact artifact bytes they will PUT."""
import base64
import json
import sys
from admission import Refusal, admit, check_lock, require, sha


def manifest_only(candidate, baseline, manifest_path):
    old, new = baseline['artifact'], candidate['artifact']
    files = lambda artifact: {row['path']: row['hash'] for row in artifact['source']['files']}
    before, after = files(old), files(new)
    require(set(before) == set(after) and manifest_path in before and all(
        after[path] == digest for path, digest in before.items() if path != manifest_path), 'MANIFEST_ONLY')
    require(candidate['clientBundle'] == baseline['clientBundle'], 'MANIFEST_ONLY')
    # Only compiler-derived server/source hashes may change along with that one input.
    stable = lambda artifact: {key: value for key, value in artifact.items() if key not in ('server', 'source')}
    require(stable(old) == stable(new) and {k: v for k, v in old['server'].items() if k != 'source'} ==
            {k: v for k, v in new['server'].items() if k != 'source'}, 'MANIFEST_ONLY')


def run(request):
    artifact = base64.b64decode(request['artifactBase64'], validate=True)
    if request.get('mode') == 'manifest-only':
        check_lock(request['lock'], request['ownerPid'])
        require(len(artifact) <= 1048576, 'ARTIFACT_TOO_LARGE')
        require(json.loads(artifact) == request['candidate']['artifact'], 'ARTIFACT_BINDING')
        manifest_only(request['candidate'], request['baseline'], request['manifestPath'])
        return {'manifestOnly': 'PASS', 'artifactSha256': sha(artifact)}
    return admit(handoff=request.get('handoff'), raw=base64.b64decode(request['rawBase64'], validate=True),
        shell=base64.b64decode(request['shellBase64'], validate=True), dashboard_id=request['dashboardId'],
        saved_keys=request['savedKeys'], deliveries=request['deliveries'], provider=request['provider'],
        artifact=artifact, lock=request['lock'], owner_pid=request['ownerPid'])


if __name__ == '__main__':
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except Refusal as error:
        print(error.code, file=sys.stderr)
        sys.exit(1)
    except (ValueError, KeyError, TypeError, OSError):
        print('ADMISSION_INPUT', file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Reject hosted audio links and file keys in Git blobs without printing them."""
import argparse
import re
import subprocess
import sys

# Match CDN file locations, including JSON-escaped slash separators.
URL = re.compile(rb'(?:utfs\.io|[a-z0-9-]+\.ufs\.sh|(?:[a-z0-9-]+\.)?uploadthing\.com)(?:\\?/)[^\s<>"\x27]*', re.I)
# Current provider keys have 48 URL-safe characters; exclude longer hashes/tokens.
KEY = re.compile(rb'(?<![a-zA-Z0-9_-])(?=[a-zA-Z0-9_-]{0,47}[a-zA-Z0-9])[a-zA-Z0-9_-]{48}(?![a-zA-Z0-9_-])')


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.PIPE)


def scan(staged=False):
    if staged:
        entries = git('ls-files', '--stage', '-z').split(b'\0')
    else:
        entries = git('ls-tree', '-r', '-z', 'HEAD').split(b'\0')
    failed = False
    for entry in entries:
        if not entry:
            continue
        meta, path = entry.split(b'\t', 1)
        fields = meta.split()
        if staged:
            mode, oid, stage = fields
            if stage != b'0':
                raise RuntimeError('Unmerged index; refusing publication check')
        else:
            mode, kind, oid = fields
            if kind != b'blob':
                raise RuntimeError('Unscannable tracked entry; refusing publication check')
        if mode not in (b'100644', b'100755', b'120000'):
            raise RuntimeError('Unscannable tracked entry; refusing publication check')
        content = git('cat-file', 'blob', oid.decode('ascii'))
        for number, line in enumerate(content.splitlines(), 1):
            if URL.search(line) or KEY.search(line):
                # CI logs are public. Never echo the matching line, URL or key.
                name = path.decode('utf8', errors='backslashreplace')
                print(f'{name}:{number}: hosted audio URL or file key prohibited', file=sys.stderr)
                failed = True
    return 1 if failed else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged', action='store_true', help='scan all index blobs for pre-commit')
    args = parser.parse_args()
    try:
        sys.exit(scan(args.staged))
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError):
        print('Publication scan could not inspect every Git blob; refusing.', file=sys.stderr)
        sys.exit(2)

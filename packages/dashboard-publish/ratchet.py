"""Configured deploy scripts must call the gate immediately before every write sink.

This checks sanctioned scripts, not arbitrary obfuscated programs or raw developer CLIs.
"""
import ast
import json
from pathlib import Path
import re
import sys


def check(paths):
    failures = []
    sink = re.compile(r'''method\s*[:=]\s*['"]PUT['"]|\blakebed[^\n]*['"]deploy['"]|\bupdate_existing\(''')
    for filename in paths:
        path = Path(filename)
        source = path.read_text()
        if path.suffix == '.py':
            tree = ast.parse(source)
            for parent in ast.walk(tree):
                for field in ('body', 'orelse', 'finalbody'):
                    statements = getattr(parent, field, None)
                    if not isinstance(statements, list): continue
                    for index, statement in enumerate(statements):
                        if not isinstance(statement, (ast.Expr, ast.Assign, ast.Return)): continue
                        line = ast.get_source_segment(source, statement) or ''
                        if not sink.search(line): continue
                        previous = ast.get_source_segment(source, statements[index - 1]) if index else ''
                        if not previous or not re.fullmatch(r'assert_publish_admission\([^\n]*\)', previous):
                            failures.append(f'{path.name}:{statement.lineno}')
        else:
            # Reject comments as gate evidence; require a standalone call beside the sink.
            clean = re.sub(r'/\*.*?\*/|(?m:^\s*//[^\n]*)', '', source, flags=re.S)
            lines = [line.strip() for line in clean.splitlines() if line.strip()]
            for index, line in enumerate(lines):
                if not sink.search(line): continue
                start = index
                if line.startswith('method:'):
                    while start and 'fetch(' not in lines[start]: start -= 1
                if not (start and re.fullmatch(r'assertPublishAdmission\([^\n]*\);', lines[start - 1])):
                    failures.append(f'{path.name}:{index + 1}')
    return failures


if __name__ == '__main__':
    errors = check(json.loads(Path(sys.argv[1]).read_text())['paths'])
    print(json.dumps({'ungated': errors}))
    sys.exit(bool(errors))

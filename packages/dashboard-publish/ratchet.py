"""Conservative checks for configured publisher source; not a general program proof."""
import ast
import json
from pathlib import Path
import re
import sys

PY_GATE = 'assert_publish_admission'
JS_GATE = 'assertPublishAdmission'


def command_sink(strings):
    command = ' '.join(strings)
    return bool(re.search(r'\blakebed(?:@[^\s\'\"]+)?\b', command) and re.search(r'\bdeploy\b', command))


def python_sink(call):
    name = call.func.attr if isinstance(call.func, ast.Attribute) else getattr(call.func, 'id', '')
    if name in ('put', 'update_existing'): return True
    for arg in call.keywords:
        if arg.arg == 'method' and (not isinstance(arg.value, ast.Constant) or arg.value.value == 'PUT'): return True
    if name == 'request' and call.args:
        if not isinstance(call.args[0], ast.Constant) or call.args[0].value == 'PUT': return True
    if name in ('run', 'call', 'Popen', 'check_call', 'check_output', 'system', 'exec', 'execSync', 'execFileSync'):
        return command_sink([node.value for node in ast.walk(call) if isinstance(node, ast.Constant) and isinstance(node.value, str)])
    return False


def header_calls(node, root=True):
    if not root and isinstance(node, ast.stmt): return
    if isinstance(node, ast.Call): yield node
    for child in ast.iter_child_nodes(node): yield from header_calls(child, False)


def python_findings(source):
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if ((isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == PY_GATE)
            or (isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)) and node.id == PY_GATE)
            or (isinstance(node, ast.arg) and node.arg == PY_GATE)):
            yield 'RATCHET_GATE_REDEFINED', node.lineno
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if (alias.asname or alias.name) == PY_GATE and not (
                    isinstance(node, ast.ImportFrom) and node.module == 'publish_admission' and alias.name == PY_GATE):
                    yield 'RATCHET_GATE_REDEFINED', node.lineno
        for _, block in ast.iter_fields(node):
            if not isinstance(block, list) or not block or not all(isinstance(row, ast.stmt) for row in block): continue
            for index, statement in enumerate(block):
                sinks = [call for call in header_calls(statement) if python_sink(call)]
                previous = block[index - 1] if index else None
                gated = (isinstance(previous, ast.Expr) and isinstance(previous.value, ast.Call)
                         and isinstance(previous.value.func, ast.Name) and previous.value.func.id == PY_GATE)
                for number, call in enumerate(sinks):
                    if not gated or number: yield 'RATCHET_UNGATED_PUT', call.lineno


# Strings and comments are tokens, so their contents cannot impersonate gate calls.
JS_TOKENS = re.compile(r'''(?P<comment>//[^\n]*|/\*.*?\*/)|(?P<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?P<word>[$a-zA-Z_][$\w]*)|(?P<punct>=>|\?\.|[^\s])''', re.S)


def javascript_findings(source):
    tokens = [(match.lastgroup, match.group(), source.count('\n', 0, match.start()) + 1)
              for match in JS_TOKENS.finditer(source) if match.lastgroup != 'comment']
    pairs, stack, imports = {}, [], set()
    for index, (_, value, _) in enumerate(tokens):
        if value in ('(', '{', '['): stack.append(index)
        elif value in (')', '}', ']') and stack:
            opening = stack.pop(); pairs[opening] = index; pairs[index] = opening
        if value == 'import':
            end = next((j for j in range(index, len(tokens)) if tokens[j][1] == ';'), len(tokens))
            if any(kind == 'string' and text[1:-1].endswith('publish-admission.mjs') for kind, text, _ in tokens[index:end]):
                imports.update(range(index, end))
    for index, (kind, value, line) in enumerate(tokens):
        following = tokens[index + 1][1] if index + 1 < len(tokens) else ''
        previous = tokens[index - 1][1] if index else ''
        if kind == 'word' and value == JS_GATE and index not in imports:
            if following != '(' or previous in ('function', 'class'):
                yield 'RATCHET_GATE_REDEFINED', line
        if kind != 'word' or following != '(' or index + 1 not in pairs: continue
        end = pairs[index + 1]
        args = tokens[index + 2:end]
        sink = value in ('put', 'update_existing')
        for offset, (_, token, _) in enumerate(args[:-2]):
            if token.strip('\'"') == 'method' and args[offset + 1][1] == ':':
                value_kind, method, _ = args[offset + 2]
                sink |= value_kind != 'string' or method[1:-1] == 'PUT'
        if value in ('execSync', 'execFileSync', 'spawnSync', 'spawn', 'exec'):
            sink |= command_sink([text[1:-1] for token_kind, text, _ in args if token_kind == 'string'])
        if not sink: continue
        semi = next((j for j in range(index - 1, -1, -1) if tokens[j][1] == ';'), -1)
        opening = pairs.get(semi - 1, -1) if semi > 0 and tokens[semi - 1][1] == ')' else -1
        gated = (opening > 0 and tokens[opening - 1][1] == JS_GATE
                 and (opening == 1 or tokens[opening - 2][1] in (';', '{', '}'))
                 and not any(text in (';', '{', '}') for _, text, _ in tokens[semi + 1:index]))
        if not gated: yield 'RATCHET_UNGATED_PUT', line


def check(paths):
    failures = []
    for filename in paths:
        path = Path(filename)
        scan = python_findings if path.suffix == '.py' else javascript_findings
        for code, line in scan(path.read_text()): failures.append(f'{code}:{path.name}:{line}')
    return failures


if __name__ == '__main__':
    errors = check(json.loads(Path(sys.argv[1]).read_text())['paths'])
    print(json.dumps({'ungated': errors}))
    sys.exit(bool(errors))

# Conformance gate

Run `bun run conformance --binding <module path>`. The parent resolves the
binding against the caller's working directory and passes an absolute path to
its children. No path enters the report. `--exit` also requires every engine
stage-A case active. `--reverse` changes execution order, not report order.

`entry.ts` does nothing at import. Its parent alone performs real I/O: spawning
two children, opening one owned loopback proxy listener, and enforcing each
child's 30-second whole-run watchdog. The binding never loads in the parent.
Each child loads `preload.ts` first and runs the cases in normal/reversed order.
Child reports travel over dedicated fd 3, separate from binding logs. The parent
forwards stdout/stderr logs to stderr and prints only the final canonical report.
Children publish synchronously to that pipe at exit, after detached rejections.
Code 3 means a completed child report, not a verdict; a child never exits 0.
The parent alone establishes CONF-01 from two parseable, equal reports and two
clean child codes. An ordinary red case does not itself fail CONF-01. Exit-kind
violations, a late unhandled rejection and a dead child have named diagnostics.
Direct runConformance calls leave CONF-01 red; no preload also fails CONF-03/04.

`inventory-trapped.json`, `inventory-safe.json` and `inventory-excluded.json`
classify every own key of Bun and every builtinModules entry. Every running
key must occur in exactly one table. Unknown keys, duplicate classifications
and missing rows fail closed, naming the capability. Safe rows give a reason
why they cannot reach network/process/clock; excluded rows name their real effects. Both Bun 1.3.11 and 1.4.4 are tested;
a row for an absent capability does not create it. Trap installation errors
fail CONF-03/04 with API names. Presence checks require the immutable installed
marker and the actual global fetch trap, not a mutable boolean alone.

Traps cover writable Bun network clients and aliases (S3, SQL, Redis, UDP),
fetch/WebSocket, all callable exports of network builtins (including ws,
undici, _http_client, http2, dns and dns/promises), process spawning/execve,
workers, timers, sleep, Date, Intl formatting without an explicit date,
process clocks, os.uptime, performance/prototype now/timeOrigin/mark/measure/
eventLoopUtilization, AbortSignal.timeout, Temporal.Now where present,
randomUUIDv7, and vm run/compile/Script constructors. ws's callable CJS default
is guarded at its superclass construction, before native transport initialization
on both Bun versions. Every listed review escape is exercised through the entry.

Bun.fetch is not trappable in process; it is caught by the parent's proxy
listener. Both cases and import-time uses inherit HTTP_PROXY, HTTPS_PROXY and
ALL_PROXY (upper/lowercase), with NO_PROXY/no_proxy empty. A connection makes
CONF-03 fail with "connection reached the parent's proxy listener". The parent
never forwards traffic. Bun.dns is also a read-only container, but its writable
lookup/resolve methods are trapped in place: standalone DNS does not use an
HTTP proxy. Node DNS is trapped directly. http2 is covered, not out of scope.
Traps persist until exit, including process.exit/reallyExit; caught calls still
record violations. The parent computes its own final exit code from its report.

This suite targets cooperative adapters, not an OS sandbox. The complete
EXCLUDED table (real effects; do not invoke these in a binding) is:

- Bun.WebView: native GUI can open windows, browser processes and network connections.
- bun:ffi: native functions can open sockets, start processes and read clocks.
- bun:wrap: internal native wrappers can expose native functions and real OS effects.
- module: native addon loading can execute arbitrary native OS effects.

Filesystem access and deliberate runtime tampering remain outside containment.
No excluded capability is invoked by the tests. Fixtures are synthetic/public;
do not supply private inputs. No speaker, microphone or real backend runs.
Fake clock scheduling is supported; explicit fixture dates remain available.

The canonical nl.conformance/1 JSON has sorted keys/ids, one final newline and
the complete registry denominator. Active rows carry a trace_digest: HMAC-SHA256
of the canonical outcome, ordered synthetic event trace and wall-violation count.
The fixed public UTF-8 fixture key is `nl.conformance/1 public synthetic fixture key`.
It enables cross-process/repository comparison, not protection against guessing.
Production diagnostics use the host's private per-install key (§2.6).

Registry: contract draft 0.2 SHA-256
`95dc426432d015c60c91c139583cd45ae2dc477eb9b8889ff1498c78720ef617`,
PLAN-v4/errata 0.3. Stage A: 62 engine, 40 host, 2 joint, 2 host-supplied; 18
stage-B rows. CONF-01/02/03/04 active; active.json stays append-only. expectEvent
asserts a required element; bare iteration does not declare an expected end.

Every case using ScriptedBackend, ScriptedSpawn or ScriptedPlayer must call
each fake's `assertDrained()` at its end. `pending` counts unused steps (and
backend requests still awaiting delivery). A late-after-cancel step waits for
abort, then delivers after its latency; without abort, draining fails explicitly.
S1b, the next slice writing cases, owns automatic runner drain enforcement.

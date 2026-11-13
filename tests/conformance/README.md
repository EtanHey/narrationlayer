# Conformance gate

Run `bun run conformance --binding <module path>`. The parent resolves the
binding against the caller's working directory and passes an absolute path to
its children. No path enters the report. `--exit` also requires every engine
stage-A case active. `--reverse` changes execution order, not report order.

`entry.ts` does nothing at import. Only its parent uses real I/O and real time:
two children, one owned loopback proxy listener, and a 30-second watchdog per
child (parent-only `NL_CONFORMANCE_WATCHDOG_MS` can shorten it for tests).
The binding loads only in preloaded children, running cases in opposite orders.
Children publish at exit over fd 3, after detached rejections; logs go to stderr.
Code 3 means a completed child report, never a verdict; children never exit 0.
The parent establishes CONF-01 from two parseable, equal reports and clean codes.
Ordinary red cases do not fail CONF-01. Exit/rejection/death diagnostics name the
cause. Direct calls leave CONF-01 red; missing preload also fails CONF-03/04.

`inventory-trapped.json`, `inventory-safe.json` and `inventory-excluded.json`
classify all own keys of globalThis/Bun and all builtinModules entries. Each
running key needs exactly one row; unknown/duplicate keys fail with their names.
Safe rows explain scope; excluded rows name real effects. Absent capabilities
are not created. Both Bun 1.3.11 and 1.4.4 are tested. Installation failures name
APIs on CONF-03/04; presence requires immutable marker and actual fetch trap.

Traps cover writable Bun network clients and aliases (S3, SQL, Redis, UDP),
fetch/WebSocket, all callable exports of network builtins (including ws,
undici, _http_client, http2, dns and dns/promises), process spawning/execve,
workers, timers, sleep, Date, Intl formatting without an explicit date,
process clocks, os.uptime, performance/prototype now/timeOrigin/mark/measure/
eventLoopUtilization, AbortSignal.timeout, Temporal.Now where present,
randomUUIDv7, and vm run/compile/Script constructors. ws's callable CJS default
is guarded at its superclass construction, before native transport initialization
on both Bun versions. ShadowRealm is trapped as kind realm, failing the active case that uses it.

Bun.fetch is immutable: default calls are caught by the parent's proxy
listener, but explicit proxy/unix options and environment edits remain OPEN until S0c. Both cases and import-time uses inherit HTTP_PROXY, HTTPS_PROXY and
ALL_PROXY (upper/lowercase), with NO_PROXY/no_proxy empty. A connection makes
CONF-03 fail with "connection reached the parent's proxy listener". The parent
never forwards traffic. Bun.dns is also a read-only container, but its writable
lookup/resolve methods are trapped in place: standalone DNS does not use an
HTTP proxy. Node DNS and http2 are trapped directly.
Traps persist until exit, including process.exit/reallyExit; caught calls still
record violations. The parent computes its own final exit code from its report.

This suite is an in-process tripwire for cooperative adapters accidentally
using real I/O. Every report declares containment: "in-process-tripwire".
It is not a containment proof. S0c will run children under an OS sandbox denying
network/process creation (sandbox-exec on macOS; network namespace on Linux)
and change this field to the sandbox name.
CONF-03/04 mean "no trapped network (or spawn) call during any active case,
and nothing arrived at the parent's listener"; consult the OPEN list below.

Open until S0c (operating-system containment):
- Bun.fetch(url, {proxy}): selects a different proxy, bypassing the listener.
- Bun.fetch(url, {unix}): reaches a unix socket, bypassing the listener.
- process.env/Bun.env proxy edits: Bun 1.3.11 freezes these variables;
  1.4.4 refuses frozen descriptors, allowing edits to bypass inherited routing.

A binding that forges a report on the report pipe commits fraud; the suite does
not defend against a binding forging the suite. The parent checks schema,
complete registry ids/order/metadata/activation, and equality of both reports.
A complete registry-shaped forgery can still pass.

Indirect clock reads (process.cpuUsage/resourceUsage, file modification times,
Bun.file.lastModified, console.time) are caught by CONF-01 only when the value
reaches an event. Local Bun.file/write paths remain usable; non-file schemes
are trapped as network before constructing a native client.

ECMAScript data/control, web data/stream/event, local descriptors and module
transforms share reviewed-safe category reasons; realm, ambient clock, network
and process capabilities have individual rows.
Other EXCLUDED capabilities (real effects; do not invoke in a binding):

- Bun.WebView: native GUI can open windows, browser processes and network connections.
- bun:ffi: native functions can open sockets, start processes and read clocks.
- bun:wrap: internal native wrappers can expose native functions and real OS effects.
- process.dlopen and module: native addon loading can execute arbitrary native OS effects.

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

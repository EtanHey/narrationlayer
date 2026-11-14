# Conformance gate

Run `bun run conformance --binding <module path>`. The parent resolves the
binding against the caller's working directory and passes an absolute path to
its children. No path enters the report. `--exit` also requires every engine
stage-A case active. `--reverse` changes execution order, not report order.

`entry.ts` does nothing at import. Only its parent uses real I/O and real time:
two children, one owned loopback proxy listener, and a 1.5-second watchdog per
child (parent-only `NL_CONFORMANCE_WATCHDOG_MS` can shorten it for tests).
The deadline bounds report/log reads and child exit together. Bun owns the extra
report descriptor; the parent does not close its raw fd a second time.
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
listener. Explicit proxy/unix options and environment edits are denied by the macOS sandbox; they remain OPEN on Linux. Both cases and import-time uses inherit HTTP_PROXY, HTTPS_PROXY and
ALL_PROXY (upper/lowercase), with NO_PROXY/no_proxy empty. A connection makes
CONF-03 fail with "connection reached the parent's proxy listener". The parent
never forwards traffic. Bun.dns is also a read-only container, but its writable
lookup/resolve methods are trapped in place: standalone DNS does not use an
HTTP proxy. Node DNS and http2 are trapped directly.
Traps persist until exit, including process.exit/reallyExit; caught calls still
record violations. The parent computes its own final exit code from its report.

What `macos-sandbox` means:

- Network operations denied except outbound IPv4 TCP to the parent's loopback
  listener port (`tcp4`). Another port and same-port IPv6 are refused.
- Process creation denied (fork and posix_spawn). Exec permits only the resolved
  Bun executable, needed for initial startup. Same-image exec with new arguments
  can drop JS traps but retains every kernel restriction; other paths are denied.
- All Mach service lookups denied, with no service-name exceptions. This closes
  the system-resolver and LaunchServices/Apple Events lookup routes; the profile
  also denies `lsopen` and `appleevent-send` (accepted on macOS 27).
- File writes denied except `/dev/null`. Inherited report/stdout/stderr descriptors
  continue to work. No per-run writable-directory exception is needed.
- Signals denied except to self; a signal-0 probe targets only an owned child.

The parent starts both children with `/usr/bin/sandbox-exec -p`. Apple deprecates
sandbox-exec but ships it on the tested macOS 27 system; the suite depends on it.
Linux or a Mac without it reports `in-process-tripwire`, never containment.
`--require-containment` or `NL_CONFORMANCE_REQUIRE_CONTAINMENT=1` fails with
`required macOS containment unavailable` instead; the macOS test requires both.
A failing launch remains red, without retrying outside the sandbox.

Platform routes (`inventory-excluded.json`'s `platform_routes`):
- Bun.fetch(url, {proxy}): denied on macOS; OPEN on Linux.
- Bun.fetch(url, {unix}): denied on macOS; OPEN on Linux.
- process.env/Bun.env proxy edits and NO_PROXY='*': denied network effects on
  macOS. OPEN on Linux with Bun 1.4.4; 1.3.11 freezes the variables.
- Bun.file/write String-object remote schemes: trapped before client creation
  on both platforms, including a String with an overridden toString: its internal
  value is read with String.prototype.valueOf.call before falling back to String(x).

CONF-03/04 still mean no trapped call and no arrival at the parent's sink.
An adapter that catches a kernel-denied call can remain green: kernel denial
proves no traffic escaped, not that a trap observed the attempt. Bun maps denied
TCP/DNS operations to ECONNREFUSED; unix reports ECONNREFUSED on 1.4.4
and ENOENT on 1.3.11; UDP, spawning, file writes and signals report EPERM.
The DNS invariant uses a private resolver pointed only at an owned loopback
UDP listener, with an NXDOMAIN control. System-resolver confinement is proven
separately: no-preload bootstrap_look_up probes for com.apple.dnssd.service,
com.apple.coreservices.launchservicesd and com.apple.coreservices.appleevents
return 1100 sandboxed and succeed in controls. Only lookup is performed, never
a message to those services. localhost resolves from /etc/hosts in process even
when lookups are denied; a localhost query or sandbox log is not this proof.
Two committed snapshots pin each containment value byte for byte, including
locale/TZ/cwd/reverse-order checks; the field is never normalized away.
Linux sandbox containment and Linux mutation-gate rows for these macOS-only
rules are deferred. The focused OS tests run without the trap preload and have
unsandboxed loopback/marker controls. No external request is used.

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
process.dlopen is a spawn tripwire because native code can request processes.
Other EXCLUDED capabilities (real effects; do not invoke in a binding):

- Bun.WebView: native GUI can open windows, browser processes and network connections.
- bun:ffi: native functions can open sockets, start processes and read clocks.
- bun:wrap: internal native wrappers can expose native functions and real OS effects.
- module: native addon loading can execute arbitrary native OS effects;
  loaded code remains subject to the profile denying all service lookups.

On Linux filesystem writes remain outside the tripwire: writing a shell profile,
LaunchAgent or git hook can start a process later. macOS denies those writes.
Deliberate report forgery remains out of scope. The only native OS probe uses
bun:ffi without preload for the three authorized lookups; it sends no message.
Fixtures are synthetic/public;
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
stage-B rows. CONF-01/02/03/04 and PLAN-LAT-01, ORDER-01, ERR-01, ID-03, ID-04, TIME-02, GEN-02, LIFE-01e, TIME-01, GEN-01e, WORD-02 and DET-01 active; active.json stays append-only. expectEvent
asserts a required element; bare iteration does not declare an expected end.

Every case using ScriptedBackend, ScriptedSpawn or ScriptedPlayer must call
each fake's `assertDrained()` at its end. `pending` counts unused steps (and
backend requests still awaiting delivery). A late-after-cancel step waits for
abort, then delivers after its latency; without abort, draining fails explicitly.
S1b, the next slice writing cases, owns automatic runner drain enforcement.

The engine binding composes the real session, read planner and publication. It
uses invented in-memory PCM and an in-memory artifact port, a fixed synthetic
Edge engine choice, and package version `0.0.0-conformance`. An absent ports
object gets an empty scripted backend, sufficient for the hello-only probe.
The probe now sends a schema-valid hello (client, binding and stage; no version
object). Null and harness-only bindings fail all eighteen engine cases, so their
entry exit is 1; their CONF verdicts retain their original meaning.

ORDER-01 covers stage-A natural completion via host feedback and the terminal
fence; its lease-backed timing_update exception remains owed to S7. Engine
selection, durable artifacts and live leases remain owed to S7. TIME-02 covers
piece and word times and any duration/audio_ready events present; S4b supplies
those additional events. Stage-A player feedback is synthetic; no player runs.
Lifecycle is advertised with LIFE-01e active. Required-capability/version negotiation and
the unconditional session gate are covered by S1b. The gate refuses a
second valid hello as INVALID_REQUEST; malformed hello keeps parser refusals.

Before welcome, every non-hello input (including malformed values) receives
NOT_NEGOTIATED. A malformed hello retains the parser code. Replayed accepted
retains its original seq; contiguity concerns new events and is checked in the
no-replay ORDER-01 case. LIFE-01e proves synthesis_requested/audio_ready; the five player edges remain
host-owned in stage A. Stage-A audible is host-owned and ignored by this binding. Shared-store
handle collisions are refused without overwrites; full custody remains S7.

The generation/time binding slice activates six more cases (sixteen active rows).
GEN-02 checks two complete three-piece reads, each with its own final duration; GEN-01e covers
first/second-piece synthesis failure. LIFE-01e checks exact scripted edge time, ordered, monotonic,
text-free engine lifecycle records on success and failure, and the capability.
TIME-01 independently sums sample fractions using BigInt, rounds once with ties
upward, and disagrees deliberately with summed rounded durations. The audio's
claimed sample rate disagrees with its WAV header. WORD-02 requires estimated
word coverage on 300/400/500 ms pieces, and DET-01 reuses identical requests with different audio lengths
in one connection. No real audio/device/backend is used. All event reads parse.
Case waits, including PLAN-LAT-01's second session and stream shutdown, have fake
clock bounds; a swallowed event fails its case rather than losing every row to
the parent's watchdog. The hello-only harness probe also has fake-clock bounds;
entry preserves its named failure when independent child reports agree. Its green
output and both null report snapshots are unchanged. Every committed broken
binding has exactly its named row red; variants use event/fixture shapes to keep
the violated rule attributable while shared success checks remain strict.
All successful reads are checked by their own session id for admission, plan,
pieces, lifecycle, one final duration, committed outcome and no errors. Intentional
failed/cancelled prefixes instead have their own nonfinal duration and terminal
receipts; ID-04 separately checks its deliberate idempotency refusal. Privacy
checks scan raw error/lifecycle events, including fields dropped by parseEvent.
TIME-01 includes a non-tie 0.3+0.3 ms pair and the documented half-up tie.
Variant entry proofs run serially.

The first planning slice adds PLAN-D5, PLAN-01, PLAN-03 and PAUSE-PL-01
(twenty active rows). It compares source-unit word ranges with plan ranges and
checks every piece_ready against plan.words, allowing the projection's terminal
full stop for headings/items. Headings and whole list items are units; the
lengths fixture has five requests, including its two-sentence item whole.
The shape fixture includes labels, inline code, link labels, a bare URL and
paragraph sentences. PLAN-D5 counts tokens containing a letter or digit.
All reads use invented in-memory PCM, fake time and synthetic stage-A feedback.

PLAN-D4 and PLAN-02 now exercise over-limit sentences through the packaged
entry. An independent document scan enumerates whitespace cuts with at least
three words on each side, preferring the last fitting comma, semicolon, colon
or spaced dash; otherwise it uses the last fitting space. It reads the serving
family's max_chars from welcome. Plain and markdown fixtures cover repeated
cuts, invalid short heads/tails, unspaced dashes and sentence-end pause controls.
PLAN-03 covers its over-limit sentence clause; PLAN-D5 covers short remainders.
The one-word remainder clause in PLAN-01 and the legacy-budget half of PLAN-03
remain owed. Over-limit headings/items remain whole and are outside this slice.
The two new broken engines consistently change plan, delivered text and backend
requests (or only pause metadata where text stays the same), each failing exactly
its named case. Twenty-eight rows are active.
PAUSE-PL-01 checks the plan half: each boundary's expected pause appears once,
on its ending segment, every raw flag is false, every pause_in is
this_piece_end, and the final pause is zero. Raw piece 0/next_piece_start is owed
to the slice enabling raw first pieces; durations including that placement are
owed to assembly. Registry owed fields record these activation limits.

Every successful read receipt now compares the fake backend's recorded calls to
delivered pieces: exactly one call per piece, in order, with the same text. The
port lacks session IDs, so ordered synthesis_requested records associate global
call positions with sessions; total call/record counts must also agree. Failed
and cancelled fixtures require their delivered prefix plus exactly one attempted
call without a piece; delivered text must still match. Each session ends at its
outcome. One unit per request and one request per piece describe this binding
today; the contract permits grouping, which remains a later design decision.

S1b makes hello mandatory and routes it through the messages module's negotiate.
UNSUPPORTED_VERSION and MISSING_CAPABILITY end the binding; NOT_NEGOTIATED permits
recovery. Six cases add fatal negotiation, required capabilities, pre-welcome
refusals, minor-0 fixture meanings, unknown fields and advertised character limits.
Lookahead is a default, overridden by any positive integer (question 39); pacing
belongs to PACE-01. Unknown capability contents are never echoed: diagnostics
name fixed capabilities and at most eight unknown required_caps array positions.
The six new broken engines each fail exactly their named case. Broader new checks
also catch the existing ID-03 engine in VER-02e and ORDER-01 engine in LIM-01,
NEG-03 and VER-01. With both slices merged, null fails twenty-two of twenty-six active rows.

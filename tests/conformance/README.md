# Conformance gate

The supported command is `bun run conformance --binding <module path>`.
Paths are resolved relative to the package root, independent of cwd. `--exit`
also requires every engine stage-A case to be active. `--reverse` changes case
execution order. Do not invoke the internal child mode as a gate.

The guarded `entry.ts` does nothing when imported. Its parent process alone
uses real spawn and a 30-second watchdog: it never imports the binding. It runs
two disposable children, one in registry order and one reversed. Each child
loads `preload.ts` before the entry, runner or binding. The parent compares the
canonical reports, including observation digests, and promotes CONF-01 only
when both children finished cleanly, the reports match, and the local probe
was deterministic. Direct `runConformance` calls leave CONF-01 red until this
comparison; without preload CONF-03/04 also fail with `traps absent`.

The preload records API names, never arguments, for forbidden calls. Caught
exceptions remain violations. Traps persist until process termination; exit is
never restored. The child's exit handler forces failure for recorded violations
or failed cases, and the parent computes its own exit status from both children
and the final report. Timers and workers cannot schedule detached work. An
unhandled rejection also forces a nonzero child status. The watchdog kills a
hung child; a missing/invalid report makes the parent fail without a green report.

Trapped APIs (each has a captured-at-import fixture in `traps.test.ts`):

- Spawn: Bun.spawn, spawnSync, $, Worker, every function export of
  node:child_process and node:worker_threads (including constructors).
- Network: fetch, WebSocket, Bun.connect/listen/serve, every function export of
  node:net/tls/http/https/dgram, and existing HTTP(S) globalAgent
  createConnection/addRequest. Builtins load before patching; ESM named exports
  are synchronized before any binding loads.
- Clocks: setTimeout/Interval/Immediate; Bun.sleep/sleepSync/nanoseconds;
  node:timers and node:timers/promises scheduling functions and scheduler
  wait/yield; Atomics.wait/waitAsync; Date() and new Date() without arguments;
  Date.now; performance.now/timeOrigin; process.hrtime/bigint/uptime;
  Intl.DateTimeFormat.format/formatToParts without an explicit date.
- Termination: process.exit. Trap installation failures are retained by name
  and fail CONF-03/04 closed; they cannot produce a passing gate.

This is a conformance harness for cooperative adapters, not an OS sandbox.
Filesystem I/O, native addons/FFI, alternate networking modules such as http2,
DNS resolvers, and deliberate runtime tampering are outside its trap inventory.
Do not run private inputs: fixtures are synthetic and public. Explicit dates
remain available; fake clock scheduling is the only supported timing source.

The report is canonical `nl.conformance/1` JSON with sorted keys and case IDs,
one final newline, no wall time or absolute paths, and the complete registry
denominator. Each active row records result, assertion count, metadata and a
trace_digest: HMAC-SHA256 of its canonical outcome, ordered synthetic trace and
wall-violation count. The fixed public fixture key is the UTF-8 string
`nl.conformance/1 public synthetic fixture key`. It provides cross-process and
cross-repository comparability; it is not a per-install privacy key. Production
diagnostics must use the host's private per-install key (§2.6).

Registry source is contract draft 0.2, SHA-256
`95dc426432d015c60c91c139583cd45ae2dc477eb9b8889ff1498c78720ef617`,
PLAN-v4 and errata 0.3. Stage A: 62 engine, 40 host, 2 joint, 2 host-supplied;
18 deferred stage-B rows. `active.json` is append-only. S0b activates CONF-03/04;
S0a's CONF-01/02 remain active. Later engine and host cases stay inactive until
implemented. `expectEvent` asserts a required stream element; bare iteration
does not assert an expected end. S0a2 owns fake ports; the host-under-test port
belongs to S6h, not the engine binding's send/events directions.

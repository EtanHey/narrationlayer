# Conformance harness (S0a)

These tests live under `tests/conformance/` because they test the suite itself,
independently of engine and host implementations. No audio, backend, network or
player runs. S0a2 implements the other fake ports; S0b owns the process preload,
complete I/O traps and packaged entry. Only CONF-01 and CONF-02 are active here.

Run `bun run conformance --binding src/engine/conformance/null-binding.ts`.
The binding module's default export implements `Binding`: a name and a factory
accepting the fake clock, hash key, store, audible predicate value and optional fake ports. Every connection exposes
synchronous `send`, an async event stream, and `shutdown(deadline)`; shutdown must
close the stream. Cases use `CaseContext.expectEvent` for required events: an
early end fails. Every event consumed through a case's binding is retained only
in memory for the determinism check. Raw events and exception text never enter
the report. No case-level wall timeout exists. The CLI has one 30-second whole-run
watchdog covering import and execution, outside the report.

CONF-01 compares two complete observation reports of all other active cases,
including assertion counts and event traces, plus a hello/shutdown probe. The
null binding is allowed to pass these harness cases; it fails the test-only probe
that requires an event. The broken binding emits an instance-dependent nonce,
which fails CONF-01 even when executions happen within one clock tick.
CONF-02 probes the binding and runs every other active case, asserting zero
recorded wall violations; it also asserts the fake clock callback boundary.
All cases run with wall timer/duration reads denied; a caught violation still
fails. This case-local guard does not replace S0b's preload or certify real I/O.

The frozen `nl.conformance/1` report has exactly these fields:

- `binding`: the binding's declared name.
- `schema`: `nl.conformance/1`.
- `registry_count`: every registry row, including deferred rows.
- `inactive`: every inactive row.
- `inactive_engine`: inactive engine stage-A rows (`--exit` fails if nonzero).
- `rows`: sorted by id; each has `id`, `result` (`pass`, `fail`, `inactive`),
  `assertions`, `owner_slice` (null for deferred rows), `side`, and `stage`.
  Active rows also carry `trace_digest`, SHA-256 of the canonical outcome,
  ordered fixture-event trace and wall-violation count.

Keys are sorted recursively; output ends in one newline. There are no path or
wall-time fields. The committed report snapshot pins the entire schema and
registry denominator. `--reverse` reverses execution, never report ordering.

Registry source: signed contract draft 0.2, SHA-256
`95dc426432d015c60c91c139583cd45ae2dc477eb9b8889ff1498c78720ef617`,
with PLAN-v4 and errata 0.3. `contract_line` is a one-based line in that exact
contract. New errata case ids cite the existing obligation, not an errata line.
Stage A matches the signed partition: 62 engine, 40 host, 2 joint, 2 host-supplied.
The 18 stage-B rows include the expressly deferred/withdrawn ASM-D7 and PACE-D6;
they have no owner in this phase. Suffix `b` distinguishes the deferred half of
PAUSE-03, SPEED-01 and JOIN-01. ORDER-01 belongs to S3b; S7 adds its lease clause.
No clause lacked a contract line. `active.json` is append-only: a slice adds its
ids while activating exactly its registry rows. `validateRegistry` rejects an
activation mismatch or an invalid stage-A owner before CLI execution.

Round 1 boundaries and types:

- Every case using ScriptedBackend, ScriptedSpawn or ScriptedPlayer must call
  each fake's `assertDrained()` at its end. `pending` counts unused steps (and
  backend requests still awaiting delivery). A late-after-cancel step waits for
  abort, then delivers after its latency; without abort, draining fails explicitly.
  S1b, the next slice writing cases, owns automatic runner drain enforcement.

- Contract §2.6: observation digests cover synthetic fixture events only. Never
  run private input through this harness: these are unkeyed test-fixture hashes,
  not production log hashes. No raw fixture event enters a report.
- CONF-02 is provisional until S0b's preload. References captured at import and
  detached tasks after a case returns escape these case-local guards. Other
  uncovered APIs: process.hrtime / bigint, Bun.nanoseconds, process.uptime,
  performance.timeOrigin, Intl.DateTimeFormat().format(), setImmediate,
  Bun.sleepSync, Atomics.wait; sockets, fetch and spawn are not trapped here.
- Short streams fail through expectEvent; a bare for-await loop does not declare
  an expected end. Later case authors must use expectEvent for required events.
- The CLI rejects process.exit during import/execution and records detached
  rejection failure explicitly. A detached failure after report publication
  makes the exit red but cannot be attributed to a case in the written report.
- FakeBackend returns audio bytes plus metadata, including independently wrong
  duration/sample fields for later decoded-audio checks. The host supplies
  hash_key, store and audible (contract §8). These are ports/types only.
- S6h adds the host-under-test shape for VoiceLayer's adapter and the reference
  and broken host stubs: a host drives engine requests and consumes events, so
  swapping Binding's directions would confuse engine and host authority.
- The temporary CLI has no incoming imports; entry-isolation.test.ts guards this
  until S0b replaces it with the packaged entry. No frozen entry test changed.

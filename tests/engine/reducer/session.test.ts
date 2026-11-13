import { nextSynthesisIndex } from "../../../src/engine/reducer/pacing";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initialState, reduce as transition, type State, type Input } from "../../../src/engine/reducer/session";
import { parseEvent } from "../../../src/engine/messages/parser";
import type { Message } from "../../../src/engine/messages/messages";
const frozen = new WeakSet<object>();
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !frozen.has(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value); frozen.add(value);
  }
  return value;
}
const reduce: typeof transition = (state, input) => transition(freeze(state), freeze(input));
const identity = { owner_epoch: 1, session_id: "session-1", attempt_id: "attempt-1" };
const current = { session_id: identity.session_id, player_instance_id: "player-1", control_epoch: 1, audio_ms: 0, piece_index: 0, piece_start_ms: 0, piece_duration_ms: 10, duration_ms: 10 };
const request: Message<"narrate"> = { protocol: "nl.engine/1", type: "narrate", request_id: "req-1", idempotency_key: "key", use: "read", input: { text: "Synthetic words only", format: "plain" }, voice: { profile: "fake", require_clone: false, fallback: "none" }, delivery: "pieces" };
function acceptance(n = 1): Input {
  const plan = { type: "plan", session_id: identity.session_id, attempt_id: identity.attempt_id, display_document: { version: 1, text: "Synthetic", speech_start: 0, blocks: [] }, words: [], pieces: Array.from({ length: n }, (_, index) => ({ piece_id: `p${index}`, index, word_start: 0, word_end: 0, raw: false, segments: [] })), engine: { family: "fake", profile_revision: "1", voice: "fake" } } satisfies Omit<Message<"plan">, "protocol" | "owner_epoch" | "seq">;
  return structuredClone({ kind: "accept", identity, current, request, plan });
}
function accepted(n = 1, authority: "engine" | "host" = "engine"): State { return reduce(initialState(1, authority), acceptance(n)).state; }
const view = (s: State) => s.sessions[identity.session_id];
function piece(index = 0): Input {
  return { kind: "backend", identity, result: { kind: "piece", piece: { type: "piece_ready", session_id: identity.session_id, attempt_id: identity.attempt_id, piece_id: `p${index}`, index, start_ms: index * 10, duration_ms: 10, spoken_text: "Synthetic", artifact: { handle: "h", lease_id: "l", format: "wav", sample_rate: 1, sample_count: 1, sha256: "synthetic" }, words: [], actual: [], synthesis: { rate: "1", attempts: [], unavailable: [], fallback_reason: null }, synthesis_ms: 0 } } };
}
const commit: Input = { kind: "backend", identity, result: { kind: "commit" } }, failure: Input = { kind: "backend", identity, result: { kind: "failure", error: { code: "SYNTH_FAILED", message: "synthetic failure" } } }, stop: Input = { kind: "stop", session_id: identity.session_id, reason: "stop" };
function feedback(edge: Message<"player_feedback">["edge"], overrides: Partial<Message<"player_feedback">> = {}, id = identity): Input {
  return { kind: "feedback", identity: id, feedback: { protocol: "nl.engine/1", type: "player_feedback", session_id: identity.session_id, player_instance_id: "player-1", control_epoch: 1, piece_index: 0, t_mono_ms: 0, edge, ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: 10 } } : {}), ...overrides } };
}
const seek = { kind: "control", command: { protocol: "nl.engine/1", type: "control", command_id: "seek-1", session_id: identity.session_id, expected_control_epoch: 1, op: "seek", args: { audio_ms: 0 } }, target: current } satisfies Input;
const run = (s: State, ...inputs: Input[]) => inputs.reduce((v, i) => reduce(v, i).state, s);
test("I01: first terminals win in either order; publication failure preserves EOF", () => {
  const ready = run(accepted(), piece(), feedback("first_sample"));
  const ended = run(ready, feedback("exited"), failure);
  expect([view(ended).playback, view(ended).generation, view(ended).outcome?.playback.reason]).toEqual(["completed", "failed", "completed"]);
  for (const inputs of [[stop, feedback("exited"), failure], [failure, feedback("exited"), stop]]) {
    const first = run(ready, inputs[0]); expect(run(first, ...inputs.slice(1))).toEqual(first);
  }
  const committed = run(ready, commit); expect(view(run(committed, failure)).generation).toBe("committed");
  const eofThenStop = run(ready, feedback("exited"), stop); expect(view(eofThenStop).playback).toBe("completed");
});
test("I02: matching feedback moves state; foreign job owner and attempt cannot", () => {
  const s = run(accepted(), piece()); expect(view(run(s, feedback("first_sample"))).started).toBe(true);
  for (const id of [{ ...identity, session_id: "session-2" }, { ...identity, owner_epoch: 2 }, { ...identity, attempt_id: "attempt-2" }]) expect(run(s, feedback("first_sample", {}, id))).toEqual(s);
  const sought = run(s, seek); expect(run(sought, feedback("exited", {}, { ...identity, owner_epoch: 2 }))).toEqual(sought);
});
test("I03: cancellation fences delivery and commit, including late backend results", () => {
  expect(view(run(accepted(), piece(), commit)).generation).toBe("committed");
  const cancelled = run(accepted(2), piece(), stop);
  expect(run(cancelled, piece(1), commit, failure)).toEqual(cancelled);
});
test("I04: natural EOF needs actual start and N-piece coverage; no seek", () => {
  for (const n of [1, 2, 5]) for (const reuse of [false, true]) {
    let s = run(accepted(n), ...Array.from({ length: n }, (_, i) => piece(i)), commit);
    for (let i = 0; i < n; i++) {
      const job = { piece_index: i, player_instance_id: reuse ? "player-1" : `player-${i + 1}` };
      s = run(s, feedback("spawned", job));
      if (i === n - 1 && n === 1) expect(view(run(s, feedback("exited", job))).playback).toBeNull();
      s = run(s, feedback("first_sample", job), feedback("exited", job));
    }
    expect(view(s).outcome?.playback.reason).toBe("completed");
  }
  const s = run(accepted(2), piece(), feedback("first_sample"), { ...seek, target: { ...current, piece_index: 1 } });
  expect(view(run(s, commit)).generation).toBe("running");
  expect(view(run(s, feedback("exited", { piece_index: 1, control_epoch: 2 }))).playback).toBeNull();
});
test("ID-01 fence (no model backing): stale feedback and controls carry current", () => {
  const s = run(accepted(2), piece(), piece(1), feedback("first_sample"), seek);
  for (const f of [feedback("exited"), feedback("exited", { control_epoch: 2, player_instance_id: "old-player" })]) {
    expect(reduce(s, f).effects).toMatchObject([{ kind: "emit", event: { type: "error", code: "STALE_EPOCH", details: { current: view(s).current } } }]);
  }
  const rejected = reduce(s, { ...seek, command: { ...seek.command, command_id: "seek-2" } });
  expect(rejected.effects).toMatchObject([{ kind: "emit", event: { type: "control_ack", reason: "STALE_EPOCH", current: view(s).current } }]);
  expect(reduce(s, { ...seek, command: { ...seek.command, session_id: "missing" } }).effects).toMatchObject([{ kind: "emit", event: { type: "error", code: "UNKNOWN_SESSION", retry: "never" } }]);
});
test("seq: rejection between emits and interleaved sessions share one owner counter", () => {
  let s = accepted(2); const second = acceptance(); if (second.kind !== "accept") throw Error("fixture");
  const inputs: Input[] = [{ kind: "admit", request }, { kind: "refuse", code: "INVALID_REQUEST", message: "invalid" }, piece(), feedback("first_sample", { control_epoch: 9 }), piece(1), { ...second, request: { ...request, request_id: "req-2", idempotency_key: "key-2" }, identity: { ...identity, session_id: "session-2" }, current: { ...current, session_id: "session-2" }, plan: { ...second.plan, session_id: "session-2" } }];
  const seq: number[] = []; for (const i of inputs) { const r = reduce(s, i); s = r.state; for (const e of r.effects) if (e.kind === "emit" && "seq" in e.event) seq.push(e.event.seq); }
  expect(seq).toEqual([3, 4, 5, 6, 7, 8]); expect(s.seq).toBe(8);
  const replay = reduce(s, { kind: "admit", request }); expect(replay.state.seq).toBe(8); expect(replay.effects).toMatchObject([{ kind: "replay", event: { type: "accepted", seq: 1 } }]);
  const first = reduce(initialState(1, "engine"), acceptance()); expect(first.effects.map(e => e.kind === "emit" ? e.event.type : e.kind)).toEqual(["accepted", "plan", "backend"]);
});
test("idempotency: first ack replays without state changes; changed args rejected; 32 receipts", () => {
  const s = run(accepted(), seek), replay = reduce(s, seek);
  expect(replay.state).toEqual(s); expect(replay.effects).toEqual([{ kind: "replay", event: view(s).receipts[0].ack }]);
  if (seek.kind !== "control") throw Error("fixture");
  expect(reduce(s, { ...seek, command: { ...seek.command, args: { audio_ms: 1 } } }).effects).toContainEqual(expect.objectContaining({ kind: "emit", event: expect.objectContaining({ reason: "command id reused" }) }));
  let many = accepted(); for (let i = 0; i < 33; i++) many = run(many, { ...seek, command: { ...seek.command, command_id: `c${i}`, expected_control_epoch: undefined } });
  expect(view(many).receipts).toHaveLength(32);
});
test("purity: imports limited to message types; serialised state reduces identically", () => {
  const source = readFileSync("src/engine/reducer/session.ts", "utf8");
  expect([...source.matchAll(/(?:from|import\s*\()\s*["']([^"']+)/g)].map(m => m[1])).toEqual(["../messages/messages"]);
  const s = run(accepted(), piece(), seek); expect(reduce(JSON.parse(JSON.stringify(s)), stop)).toEqual(reduce(s, stop));
  const before = JSON.stringify(s); reduce(s, stop); expect(JSON.stringify(s)).toBe(before);
});
test("I01: a player failure after the natural end keeps completed", () => {
  const s = run(accepted(), piece(), feedback("first_sample"), feedback("exited"));
  expect(run(s, feedback("exited", { exit: { status: "failed", stopped_at_ms: 0 } }))).toEqual(s);
});
test("I03: cancelled attempt emits no piece_ready", () => {
  const s = run(accepted(2), piece(), stop);
  expect(reduce(s, piece(1)).effects).toEqual([]);
});
test("live job: next delivered player advances and previous exit settles", () => {
  const s = run(accepted(2), piece(), piece(1), feedback("spawned", { piece_index: 1, player_instance_id: "player-2" }));
  expect(view(s).current.player_instance_id).toBe("player-2");
  expect(reduce(s, feedback("exited")).effects).toEqual([]);
});
test("epoch authority: host adopts speed/restart generations; engine mints each reanchor", () => {
  let host = run(accepted(1, "host"), piece());
  host = run(host, feedback("first_sample", { control_epoch: 8 }), feedback("exited", { control_epoch: 8 }), commit);
  expect(view(host).outcome?.playback.reason).toBe("completed"); expect(view(host).current.control_epoch).toBe(8);
  const command = { ...seek, target: { ...current, control_epoch: 7 } };
  expect(view(run(accepted(1, "host"), command)).current.control_epoch).toBe(7);
  let engine = accepted();
  for (const op of ["pause", "resume", "seek"] as const) {
    const c: Message<"control"> = op === "seek" ? { ...seek.command, command_id: op, expected_control_epoch: undefined } : { ...seek.command, op, command_id: op, expected_control_epoch: undefined, args: { owner: "user" } };
    engine = run(engine, { kind: "control", command: c, target: current });
  }
  for (const reason of ["restart", "speed"] as const) engine = run(engine, { kind: "reanchor", session_id: identity.session_id, reason, target: current });
  expect(view(engine).current.control_epoch).toBe(6);
  const ended = run(accepted(), piece(), feedback("first_sample"), feedback("exited"));
  expect(run(ended, { kind: "reanchor", session_id: identity.session_id, reason: "restart", target: current })).toEqual(ended);
  const parked = run(accepted(1, "host"), command);
  expect(reduce(parked, { ...seek, command: { ...seek.command, command_id: "low", expected_control_epoch: undefined }, target: current }).effects).toMatchObject([{ kind: "emit", event: { reason: "STALE_EPOCH" } }]);
  expect(reduce(parked, { kind: "reanchor", session_id: identity.session_id, reason: "speed", target: current }).effects).toEqual([{ kind: "reject", reason: "HOST_REANCHOR" }]);
});
test("stop wins: stale control stop is accepted and fences late pieces", () => {
  const s = run(accepted(2), seek), command: Message<"control"> = { ...seek.command, command_id: "stop", op: "stop", args: { scope: "session", reason: "stop" } };
  const r = reduce(s, { kind: "control", command, target: current });
  expect(r.effects).toContainEqual(expect.objectContaining({ kind: "emit", event: expect.objectContaining({ type: "control_ack", outcome: "accept" }) }));
  expect(view(r.state).fenced).toBe(true); expect(reduce(r.state, piece()).effects).toEqual([]);
});
test("feedback guards: wire session, piece, delivered spawn, epoch and terminal", () => {
  const s = run(accepted(2), piece());
  for (const f of [feedback("first_sample", { session_id: "foreign", control_epoch: 0 }), feedback("first_sample", { piece_index: 1 }), feedback("exited", { piece_index: 1, exit: { status: "failed", stopped_at_ms: 0 } }), feedback("spawned", { piece_index: 1 }), feedback("spawned", { piece_index: 2 })]) expect(run(s, f)).toEqual(s);
  const full = run(accepted(3), piece(), piece(1), piece(2));
  expect(run(full, feedback("spawned", { piece_index: 2, player_instance_id: "far-player" }))).toEqual({ ...full, seq: full.seq + 1 });
  const host = run(accepted(1, "host"), piece(), { ...seek, target: { ...current, control_epoch: 3 } });
  expect(reduce(host, feedback("first_sample", { control_epoch: 2 })).effects).toMatchObject([{ kind: "emit", event: { code: "STALE_EPOCH" } }]);
});
test("A1: previous player exits settle in both orders with distinct and reused ids", () => {
  for (const reuse of [false, true]) for (const status of ["completed", "failed"] as const) for (const spawnFirst of [false, true]) {
    const s = run(accepted(2), piece(), piece(1), commit, feedback("first_sample"));
    const spawn = feedback("spawned", { piece_index: 1, player_instance_id: reuse ? "player-1" : "player-2" });
    const exit = feedback("exited", { exit: { status, stopped_at_ms: 10 } });
    const r = reduce(run(s, ...(spawnFirst ? [spawn, spawn] : [exit])), spawnFirst ? exit : spawn);
    expect(r.effects.some(e => e.kind === "emit" && e.event.type === "error")).toBe(false);
    expect(view(r.state).playback).toBe(status === "failed" ? "player_failed" : null);
    if (spawnFirst) expect(view(r.state).previous).toBeNull();
  }
});
test("job fence: same-piece different instance requires a new epoch; epochs clear previous", () => {
  let s = run(accepted(2), piece(), piece(1), feedback("spawned", { piece_index: 1, player_instance_id: "player-2" }));
  expect(reduce(s, feedback("spawned", { piece_index: 1, player_instance_id: "player-3" })).effects).toMatchObject([{ kind: "emit", event: { code: "STALE_EPOCH" } }]);
  s = run(s, { kind: "reanchor", session_id: identity.session_id, reason: "restart", target: { ...current, piece_index: 1 } });
  expect(view(s).previous).toBeNull();
  const host = run(accepted(2, "host"), piece(), piece(1), feedback("spawned", { piece_index: 1, player_instance_id: "player-2" }));
  expect(view(run(host, feedback("first_sample", { piece_index: 1, player_instance_id: "player-2", control_epoch: 2 }))).previous).toBeNull();
  expect(view(run(host, feedback("exited", { control_epoch: 2, exit: { status: "failed", stopped_at_ms: 0 } }))).playback).toBeNull();
  expect(view(run(host, feedback("exited", { player_instance_id: "wrong", exit: { status: "failed", stopped_at_ms: 0 } }))).playback).toBeNull();
  expect(view(run(s, feedback("spawned", { piece_index: 1, player_instance_id: "player-3", control_epoch: 2 }))).current.player_instance_id).toBe("player-3");
});
test("I04: completed exit must be the final planned piece", () => {
  const s = run(accepted(2), piece(), piece(1), feedback("first_sample"));
  expect(view(run(s, feedback("exited"))).playback).toBeNull();
});
test("control fence: wrong player instance gets one stale ack", () => {
  const s = accepted(); expect(reduce(s, { ...seek, command: { ...seek.command, player_instance_id: "wrong" } }).effects).toMatchObject([{ kind: "emit", event: { type: "control_ack", reason: "STALE_EPOCH" } }]);
});
test("authority: engine-wide stage and host reanchor is internal refusal; replay commands do not alias", () => {
  const host = initialState(1, "host"), reanchor = { kind: "reanchor", session_id: identity.session_id, reason: "speed", target: current } satisfies Input;
  // @ts-expect-error Host bindings do not have a reanchor input.
  const refused = reduce(host, reanchor);
  expect(reduce(initialState(1, "engine"), reanchor).effects).toEqual([{ kind: "reject", reason: "UNKNOWN_SESSION" }]);
  expect(reduce(run(accepted(), stop), reanchor).effects).toEqual([{ kind: "reject", reason: "TERMINAL" }]);
  expect(refused.effects).toEqual([{ kind: "reject", reason: "HOST_REANCHOR" }]);
  const input = acceptance(); if (input.kind !== "accept") throw Error("fixture"); const s: State = reduce(host, input).state;
  expect(view(s).request).toBe(input.request); expect(view(s).plan).toBe(input.plan); expect(view(s).current).toBe(input.current);
  const result = piece(); const delivered = reduce(s, result).state;
  if (result.kind === "backend" && result.result.kind === "piece") expect(view(delivered).delivered[0]).toBe(result.result.piece);
  const command = structuredClone(seek), commanded = transition(freeze(s), command).state; command.command.command_id = "changed";
  expect(view(commanded).receipts[0].command.command_id).toBe("seek-1");
});
test("exhaustive: I01 I02 I03 I04 and guards through depth 4 with two-piece sessions", () => {
  const other = acceptance(2); if (other.kind !== "accept") throw Error("fixture");
  const second: Input = { ...other, request: { ...request, request_id: "req-2", idempotency_key: "key-2" }, identity: { ...identity, session_id: "session-2" }, current: { ...current, session_id: "session-2" }, plan: { ...other.plan, session_id: "session-2" } };
  const controls: Input[] = []; for (const reason of ["stop", "cancel", "replaced"] as const) controls.push({ kind: "control", command: { ...seek.command, command_id: reason, op: "stop", args: { scope: "session", reason } }, target: current });
  const toLast: Input = { ...seek, target: { ...current, piece_index: 1 } };
  const alphabet: Input[] = [{ ...other, identity: { ...identity, session_id: "session-3" }, current: { ...current, session_id: "session-3" }, plan: { ...other.plan, session_id: "session-3" } },{ kind: "admit", request }, { kind: "admit", request: { ...request, idempotency_key: "new" } }, { kind: "admit", request: { ...request, rate: "+1%" } }, { kind: "refuse", code: "INVALID_REQUEST", message: "invalid" }, feedback("exited", { control_epoch: 2, exit: { status: "failed", stopped_at_ms: 0 } }), feedback("exited", { player_instance_id: "wrong", exit: { status: "failed", stopped_at_ms: 0 } }), feedback("spawned", { piece_index: 1 }), feedback("exited", { piece_index: 1 }), feedback("exited", { exit: { status: "failed", stopped_at_ms: 0 } }), { ...seek, command: { ...seek.command, command_id: "wrong-player", expected_control_epoch: undefined, player_instance_id: "wrong" } }, feedback("spawned", { player_instance_id: "wrong" }), { ...seek, command: { ...seek.command, command_id: "host-low", expected_control_epoch: undefined } }, piece(), piece(1), commit, failure, ...controls, feedback("first_sample"), feedback("exited"), feedback("spawned", { piece_index: 1, player_instance_id: "player-2" }), feedback("spawned", { piece_index: 2 }), feedback("spawned"), feedback("first_sample", { control_epoch: 2 }),
    feedback("first_sample", { piece_index: 1, player_instance_id: "player-2" }), feedback("exited", { piece_index: 1, player_instance_id: "player-2" }), feedback("exited", { piece_index: 1, control_epoch: 2 }), feedback("exited", { piece_index: 1, control_epoch: 2, exit: { status: "failed", stopped_at_ms: 0 } }),
    feedback("first_sample", {}, { ...identity, owner_epoch: 2 }), feedback("first_sample", {}, { ...identity, attempt_id: "attempt-2" }), feedback("first_sample", {}, { ...identity, session_id: "session-2" }), feedback("first_sample", { session_id: "foreign", control_epoch: 0 }),
    { ...seek, command: { ...seek.command, session_id: "missing" } }, toLast, { ...seek, command: { ...seek.command, command_id: "seek-2" } }, { ...seek, command: { ...seek.command, session_id: "session-2" } }, { kind: "reanchor", session_id: identity.session_id, reason: "speed", target: current }, { kind: "reanchor", session_id: identity.session_id, reason: "restart", target: { ...current, control_epoch: 3 } }];
  const bare = run(accepted(2), second), ready = run(bare, piece(), piece(1)), host = run(accepted(2, "host"), second, piece(), piece(1));
  let frontier = new Map<string, { state: State; paths: number }>([bare, ready, host].map(state => [JSON.stringify(state), { state, paths: 1 }]));
  const parsedEvents = new Set<string>();
  const distinct = new Set<string>(); let visits = 0, scripts = 3; const start = performance.now();
  // Reducer snapshots and effects are immutable throughout this traversal.
  const fingerprints = new WeakMap<object, string>();
  function encode(value: unknown): string | undefined {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    const prior = fingerprints.get(value); if (prior !== undefined) return prior;
    const encoded = JSON.stringify(value); fingerprints.set(value, encoded); return encoded;
  }
  const same = (a: unknown, b: unknown) => encode(a) === encode(b);
  function check(before: State, input: Input, after: State, effects: ReturnType<typeof reduce>["effects"]) {
    const id = input.kind === "control" ? input.command.session_id : identity.session_id;
    const a = before.sessions[id], b = after.sessions[id], emitted = effects.flatMap(e => e.kind === "emit" ? [e.event] : []);
    if (emitted.some((e, i) => !("seq" in e) || e.seq !== before.seq + i + 1) || after.seq !== before.seq + emitted.length) throw Error("seq");
    for (const e of effects) if (e.kind === "emit" || e.kind === "replay") {
      const encoded = JSON.stringify(e.event);
      if (!parsedEvents.has(encoded)) { const parsed = parseEvent(e.event); if (!parsed.ok || parsed.value === null) throw Error(`event parser: ${JSON.stringify(parsed)}`); parsedEvents.add(encoded); }
    }
    if (input.kind === "admit" || input.kind === "accept") {
      const receipt = before.admissions[input.request.idempotency_key];
      if (receipt) {
        if (same(before.sessions[receipt.session_id].request, input.request)) {
          if (effects.length !== 1 || effects[0].kind !== "replay" || !same(effects[0].event, receipt.accepted) || receipt.accepted.seq > before.seq) throw Error("accepted replay");
        } else if (effects.length !== 1 || emitted[0]?.type !== "error" || emitted[0].code !== "IDEMPOTENCY_CONFLICT") throw Error("admission conflict");
      }
    }
    if (input.kind === "admit" || input.kind === "refuse" || input.kind === "accept") { if (!same(before.sessions, after.sessions) || !same(before.admissions, after.admissions)) throw Error("admission changed sessions/index"); return; }
    if (input.kind === "reanchor" && before.epoch_authority === "host") { if (!same(before, after) || effects[0]?.kind !== "reject") throw Error("host reanchor"); return; }
    if (!a) { if (!emitted.some(e => e.type === "error" && e.code === "UNKNOWN_SESSION")) throw Error("unknown session"); return; }
    if (input.kind === "backend" && input.result.kind === "failure" && !a.outcome && !a.fenced && a.generation === "running" && input.identity.owner_epoch === a.owner_epoch && input.identity.attempt_id === a.attempt_id) {
      if (emitted.length !== 2 || emitted[0].type !== "error" || emitted[1].type !== "outcome") throw Error("failure error then outcome");
    }
    for (const id of Object.keys(before.sessions)) {
      const x = before.sessions[id], y = after.sessions[id];
      if (input.kind === "reanchor" && input.session_id === id && x.playback !== null && !same(x.current, y.current)) throw Error("terminal reanchor");
      if ((x.outcome && !same(x.outcome, y.outcome)) || (x.generation !== "running" && x.generation !== y.generation) || (x.playback !== null && x.playback !== y.playback)) throw Error("I01");
      if (x.fenced && (!same(x.delivered, y.delivered) || emitted.some(e => e.type === "piece_ready" && e.session_id === id))) throw Error("I03 effects");
      if (y.playback === "completed" && (!y.eof || !y.started || y.delivered.length !== y.plan.pieces.length)) throw Error("I04 playback");
      if (y.generation === "committed" && y.delivered.length !== y.plan.pieces.length) throw Error("I04 generation");
    }
    if (input.kind === "feedback") {
      const f = input.feedback, foreign = input.identity.owner_epoch !== a.owner_epoch || input.identity.attempt_id !== a.attempt_id || input.identity.session_id !== a.session_id || f.session_id !== a.session_id;
      if (foreign) { if (!same(before, after) || effects.length) throw Error("I02"); return; }
      if (a.outcome || a.playback !== null) return;
      const previous = f.edge === "exited" && f.control_epoch === a.current.control_epoch && a.previous?.piece_index === f.piece_index && a.previous.player_instance_id === f.player_instance_id;
      if (previous) { if (emitted.some(e => e.type === "error") || (f.exit?.status === "failed" && b.playback !== "player_failed") || b.previous !== null) throw Error("A1"); return; }
      if (f.edge === "exited" && f.exit?.status === "completed" && f.piece_index !== a.plan.pieces.at(-1)?.index && b.playback === "completed") throw Error("I04 final piece");
      const epochOK = before.epoch_authority === "host" ? f.control_epoch >= a.current.control_epoch : f.control_epoch === a.current.control_epoch;
      const spawnOK = f.edge === "spawned" && (f.piece_index === a.current.piece_index + 1 || (f.piece_index === a.current.piece_index && (f.player_instance_id === a.current.player_instance_id || f.control_epoch > a.job_epoch))) && a.delivered.some(p => p.index === f.piece_index);
      if (epochOK && (spawnOK || (f.piece_index === a.current.piece_index && f.player_instance_id === a.current.player_instance_id)) && before.epoch_authority === "host" && b.current.control_epoch !== f.control_epoch) throw Error("host feedback epoch");
      if (epochOK && spawnOK && f.piece_index === a.current.piece_index + 1 && f.control_epoch === a.current.control_epoch && !same(b.previous, { player_instance_id: a.current.player_instance_id, piece_index: a.current.piece_index })) throw Error("A1 slot");
      if (epochOK && spawnOK && (b.current.player_instance_id !== f.player_instance_id || b.current.piece_index !== f.piece_index)) throw Error("live job");
      if ((!epochOK || (!spawnOK && f.player_instance_id !== a.current.player_instance_id)) && !emitted.some(e => e.type === "error" && e.code === "STALE_EPOCH")) throw Error("ID-01");
      if (epochOK && !spawnOK && f.piece_index !== a.current.piece_index && !same(a, b)) throw Error("piece guard");
    }
    if (input.kind === "reanchor" && !a.outcome && a.playback === null) {
      const expected = before.epoch_authority === "engine" ? a.current.control_epoch + 1 : input.target.control_epoch;
      if (before.epoch_authority === "engine") { if (b.current.control_epoch !== expected) throw Error("epoch authority"); }
      else if (!emitted.some(e => e.type === "error" && e.code === "STALE_EPOCH")) throw Error("host stale anchor");
    }
    if (b.current.control_epoch !== a.current.control_epoch && b.previous !== null) throw Error("previous epoch");
    if (input.kind === "control") {
      const receipt = a.receipts.find(r => r.command.command_id === input.command.command_id);
      if (receipt && same(receipt.command, input.command)) { if (!same(before, after) || effects[0]?.kind !== "replay") throw Error("idempotency"); }
      const stale = input.command.op !== "stop" && ((input.command.player_instance_id !== undefined && input.command.player_instance_id !== a.current.player_instance_id) || (input.command.expected_control_epoch !== undefined && input.command.expected_control_epoch !== a.current.control_epoch) || (before.epoch_authority === "host" && input.target.control_epoch < a.current.control_epoch));
      if (!receipt && stale && !emitted.some(e => e.type === "control_ack" && e.reason === "STALE_EPOCH")) throw Error("control fence");
    }
    if (input.kind === "control" && input.command.op === "stop" && a.generation === "running" && !a.outcome && a.playback === null && !a.receipts.some(r => r.command.command_id === input.command.command_id)) {
      if (!b.fenced || b.generation !== "cancelled") throw Error("I03 cancellation / stop wins");
    }
  }
  for (let depth = 0; depth <= 4; depth++) {
    const next = new Map<string, { state: State; paths: number }>();
    for (const [k, { state, paths }] of frontier) {
      for (const session of Object.values(state.sessions)) for (const lookahead of [0, 1, 2]) {
        const index = nextSynthesisIndex(session, lookahead, state.sessions);
        if (index !== undefined && (session.fenced || session.generation !== "running" || index !== session.delivered.length || index >= session.plan.pieces.length || index > session.current.piece_index + Math.max(1, lookahead))) throw Error("pacing");
      }
      visits++; distinct.add(k); if (depth === 4) continue;
      for (const input of alphabet) {
        const r = reduce(state, input); check(state, input, r.state, r.effects); scripts += paths;
        const key = JSON.stringify(r.state), old = next.get(key); next.set(key, { state: r.state, paths: paths + (old?.paths ?? 0) });
      }
    }
    frontier = next;
  }
  console.log(`exhaustive depth=4 alphabet=${alphabet.length} scripts=${scripts} visits=${visits} distinct=${distinct.size} wall_ms=${(performance.now() - start).toFixed(1)}`);
  expect(visits).toBe(44227); expect(distinct.size).toBe(38729);
  expect(scripts).toBe(7876923);
  expect(scripts).toBe(3 * (1 + alphabet.length + alphabet.length ** 2 + alphabet.length ** 3 + alphabet.length ** 4));
}, 20000);
test("admit: a new request changes nothing and asks for a plan", () => {
  const s = initialState(1, "engine"), r = reduce(s, { kind: "admit", request });
  expect(r.state).toBe(s); expect(r.effects).toEqual([{ kind: "plan", request }]);
});
test("ID-04: same key and same request replays the original accepted; a different request conflicts; a different key is a new session", () => {
  const first = reduce(initialState(1, "engine"), acceptance());
  const original = first.effects[0]; if (original.kind !== "emit" || original.event.type !== "accepted") throw Error("expected original accepted");
  const s: State = JSON.parse(JSON.stringify(run(first.state, piece(), stop)));
  const replay = reduce(s, { kind: "admit", request: { ...request, input: { format: "plain", text: request.input.text }, rate: undefined } });
  expect(replay.state).toBe(s); expect(replay.effects).toEqual([{ kind: "replay", event: original.event }]);
  const duplicate = acceptance(); if (duplicate.kind !== "accept") throw Error("fixture");
  duplicate.identity.session_id = duplicate.plan.session_id = duplicate.current.session_id = "session-2";
  expect(reduce(s, duplicate)).toEqual(replay);
  const duplicateConflict = reduce(s, { ...duplicate, request: { ...request, request_id: "different" } });
  expect(Object.keys(duplicateConflict.state.sessions)).toEqual(["session-1"]);
  expect(duplicateConflict.effects).toMatchObject([{ kind: "emit", event: { type: "error", code: "IDEMPOTENCY_CONFLICT" } }]);
  const conflict = reduce(s, { kind: "admit", request: { ...request, request_id: "different" } });
  expect(conflict.effects).toEqual([{ kind: "emit", event: { protocol: "nl.engine/1", type: "error", owner_epoch: 1, seq: s.seq + 1, code: "IDEMPOTENCY_CONFLICT", phase: "admit", retry: "never", message: "idempotency key reused", request_id: "different" } }]);
  expect(duplicateConflict).toEqual(conflict);
  expect(conflict.state.sessions).toEqual(s.sessions); expect(conflict.state.admissions).toEqual(s.admissions);
  const next = acceptance(); if (next.kind !== "accept") throw Error("fixture");
  next.request = { ...request, request_id: "req-2", idempotency_key: "__proto__" };
  next.identity.session_id = next.plan.session_id = next.current.session_id = "session-2";
  expect(reduce(s, { kind: "admit", request: next.request }).effects).toEqual([{ kind: "plan", request: next.request }]);
  const two = reduce(s, next); expect(Object.keys(two.state.sessions)).toHaveLength(2);
  expect(reduce(JSON.parse(JSON.stringify(two.state)), { kind: "admit", request: next.request }).effects).toMatchObject([{ kind: "replay", event: { type: "accepted", session_id: "session-2" } }]);
});
test("refuse: one sequenced error, no session", () => {
  for (const [code, phase, retry] of [
    ["INVALID_REQUEST", "admit", "never"], ["INPUT_TOO_LONG", "admit", "never"], ["VOICE_UNAVAILABLE", "admit", "new_request"],
    ["NOT_NEGOTIATED", "negotiate", "after_resync"], ["UNSUPPORTED_VERSION", "negotiate", "never"], ["MISSING_CAPABILITY", "negotiate", "never"],
  ] as const) {
    const s = accepted(), input = { kind: "refuse", code, message: "synthetic", request_id: "req-bad", type: "accepted", details: { text: "private" }, phase: "plan", retry: "same_request", session_id: "injected" } as const;
    const r = reduce(s, input);
    expect(r.state).toEqual({ ...s, seq: s.seq + 1 });
    expect(r.effects).toEqual([{ kind: "emit", event: { type: "error", code, phase, retry, message: "synthetic", request_id: "req-bad", protocol: "nl.engine/1", owner_epoch: 1, seq: s.seq + 1 } }]);
    expect(parseEvent(r.effects[0].kind === "emit" ? r.effects[0].event : null).ok).toBe(true);
  }
  const s = accepted(), unknown = { kind: "refuse", code: "__proto__", message: "unknown" } as const;
  // @ts-expect-error Exercise an unknown runtime code from an untyped caller.
  expect(reduce(s, unknown)).toEqual({ state: s, effects: [{ kind: "reject", reason: "INVALID_REFUSAL" }] });
});
test("ERR-01: a live failure emits error then outcome; a fenced or terminal one emits nothing", () => {
  for (const code of ["SYNTH_FAILED", "SYNTH_TIMEOUT", "ENGINE_UNAVAILABLE", "VOICE_UNAVAILABLE"] as const) {
    const input: Input = { kind: "backend", identity, result: { kind: "failure", error: { code, message: "synthetic failure" } } };
    const backendError = { code, message: "synthetic failure", type: "outcome", details: { text: "private" }, request_id: "injected" };
    const extra = reduce(accepted(), { kind: "backend", identity, result: { kind: "failure", error: backendError } });
    expect(extra.effects[0]).toEqual({ kind: "emit", event: { type: "error", code, message: "synthetic failure", phase: "synthesize", retry: "new_request", session_id: identity.session_id, protocol: "nl.engine/1", owner_epoch: 1, seq: 3 } });
    expect(parseEvent(extra.effects[0].kind === "emit" ? extra.effects[0].event : null).ok).toBe(true);
    for (const s of [accepted(), run(accepted(), piece()), run(accepted(), piece(), feedback("first_sample")), run(accepted(), piece(), feedback("first_sample"), feedback("exited"))]) {
      const r = reduce(s, input);
      expect(r.effects).toMatchObject([{ kind: "emit", event: { type: "error", code, phase: "synthesize", retry: "new_request", session_id: identity.session_id, seq: s.seq + 1 } }, { kind: "emit", event: { type: "outcome", seq: s.seq + 2, generation: { status: "failed" }, playback: { reason: view(s).playback ?? (view(s).delivered.length === 0 ? "synth_failed" : "speech_failed") } } }]);
      for (const e of r.effects) if (e.kind === "emit") expect(parseEvent(e.event).ok).toBe(true);
      expect(reduce(r.state, input).effects).toEqual([]);
    }
    for (const s of [run(accepted(), stop), run(accepted(), piece(), commit)]) expect(reduce(s, input).effects).toEqual([]);
  }
});

test("GEN-01: failure before any delivered piece ends synth_failed", () => {
  const r = reduce(accepted(), failure);
  expect(view(r.state).outcome?.playback.reason).toBe("synth_failed");
});
test("GEN-01: failure after a delivered piece ends speech_failed even before playback starts", () => {
  const r = reduce(run(accepted(2), piece()), failure);
  expect(view(r.state).started).toBe(false);
  expect(view(r.state).outcome?.playback.reason).toBe("speech_failed");
});

test("immutability: reduce never writes to its state or its input", () => {
  const s = accepted(2), delivered = reduce(s, piece()).state;
  expect(view(delivered).request).toBe(view(s).request); expect(view(delivered).plan).toBe(view(s).plan);
  expect(view(delivered).current).toBe(view(s).current); expect(view(s).delivered).toHaveLength(0);
  const next = reduce(delivered, piece(1)).state;
  expect(view(next).delivered[0]).toBe(view(delivered).delivered[0]);
  expect(reduce(next, { ...commit, identity: { ...identity, attempt_id: "foreign" } }).state).toBe(next);
  const sampled = reduce(next, feedback("first_sample")).state;
  expect(reduce(sampled, feedback("first_sample")).state).toBe(sampled);
  const stale = reduce(next, { ...seek, command: { ...seek.command, expected_control_epoch: 99 } }).state;
  expect(view(stale).receipts[0].ack.current).toEqual(view(next).current);
  expect(view(stale).receipts[0].ack.current).not.toBe(view(next).current);
  const other = acceptance(); if (other.kind !== "accept") throw Error("fixture");
  const two = reduce(next, { ...other, identity: { ...identity, session_id: "second" }, request: { ...request, idempotency_key: "second" }, current: { ...current, session_id: "second" }, plan: { ...other.plan, session_id: "second" } }).state;
  expect(reduce(two, stop).state.sessions.second).toBe(two.sessions.second);
  expect(reduce(two, { kind: "refuse", code: "INVALID_REQUEST", message: "synthetic" }).state.sessions).toBe(two.sessions);
});

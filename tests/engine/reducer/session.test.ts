import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initialState, reduce, type State, type Input } from "../../../src/engine/reducer/session";
import type { Message } from "../../../src/engine/messages/messages";
const identity = { owner_epoch: 1, session_id: "session-1", attempt_id: "attempt-1" };
const current = { session_id: identity.session_id, player_instance_id: "player-1", control_epoch: 1, audio_ms: 0, piece_index: 0, piece_start_ms: 0, piece_duration_ms: 10, duration_ms: 10 };
const request: Message<"narrate"> = { protocol: "nl.engine/1", type: "narrate", request_id: "req-1", idempotency_key: "key", use: "read", input: { text: "Synthetic words only", format: "plain" }, voice: { profile: "fake", require_clone: false, fallback: "none" }, delivery: "pieces" };
function acceptance(n = 1, epoch_authority: "engine" | "host" = "engine"): Input {
  const plan = { type: "plan", session_id: identity.session_id, attempt_id: identity.attempt_id, display_document: { version: 1, text: "Synthetic", speech_start: 0, blocks: [] }, words: [], pieces: Array.from({ length: n }, (_, index) => ({ piece_id: `p${index}`, index, word_start: 0, word_end: 0, raw: false, segments: [] })), engine: { family: "fake", profile_revision: "1", voice: "fake" } } satisfies Omit<Message<"plan">, "protocol" | "owner_epoch" | "seq">;
  return { kind: "accept", identity, current, epoch_authority, request, plan };
}
function accepted(n = 1, authority: "engine" | "host" = "engine"): State { return reduce(initialState(1), acceptance(n, authority)).state; }
const view = (s: State) => s.sessions[identity.session_id];
function piece(index = 0): Input {
  return { kind: "backend", identity, result: { kind: "piece", piece: { type: "piece_ready", session_id: identity.session_id, attempt_id: identity.attempt_id, piece_id: `p${index}`, index, start_ms: index * 10, duration_ms: 10, spoken_text: "Synthetic", artifact: { handle: "h", lease_id: "l", format: "wav", sample_rate: 1, sample_count: 1, sha256: "synthetic" }, words: [], actual: [], synthesis: { rate: "1", attempts: [], unavailable: [], fallback_reason: null }, synthesis_ms: 0 } } };
}
const commit: Input = { kind: "backend", identity, result: { kind: "commit" } }, failure: Input = { kind: "backend", identity, result: { kind: "failure" } }, stop: Input = { kind: "stop", session_id: identity.session_id, reason: "stop" };
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
  const inputs: Input[] = [piece(), feedback("first_sample", { control_epoch: 9 }), piece(1), { ...second, identity: { ...identity, session_id: "session-2" }, current: { ...current, session_id: "session-2" }, plan: { ...second.plan, session_id: "session-2" } }];
  const seq: number[] = []; for (const i of inputs) { const r = reduce(s, i); s = r.state; for (const e of r.effects) if (e.kind === "emit" && "seq" in e.event) seq.push(e.event.seq); }
  expect(seq).toEqual([3, 4, 5, 6, 7]); expect(s.seq).toBe(7);
  const first = reduce(initialState(1), acceptance()); expect(first.effects.map(e => e.kind === "emit" ? e.event.type : e.kind)).toEqual(["accepted", "plan", "backend"]);
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
test("live job: next delivered player advances and old player exits are stale", () => {
  const s = run(accepted(2), piece(), piece(1), feedback("spawned", { piece_index: 1, player_instance_id: "player-2" }));
  expect(view(s).current.player_instance_id).toBe("player-2");
  expect(reduce(s, feedback("exited")).effects).toMatchObject([{ kind: "emit", event: { code: "STALE_EPOCH" } }]);
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
  expect(reduce(parked, { kind: "reanchor", session_id: identity.session_id, reason: "speed", target: current }).effects).toMatchObject([{ kind: "emit", event: { code: "STALE_EPOCH" } }]);
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
test("exhaustive: I01 I02 I03 I04 and guards through depth 4 with two-piece sessions", () => {
  const other = acceptance(2); if (other.kind !== "accept") throw Error("fixture");
  const second: Input = { ...other, identity: { ...identity, session_id: "session-2" }, current: { ...current, session_id: "session-2" }, plan: { ...other.plan, session_id: "session-2" } };
  const controls: Input[] = []; for (const reason of ["stop", "cancel", "replaced"] as const) controls.push({ kind: "control", command: { ...seek.command, command_id: reason, op: "stop", args: { scope: "session", reason } }, target: current });
  const toLast: Input = { ...seek, target: { ...current, piece_index: 1 } };
  const alphabet: Input[] = [{ ...seek, command: { ...seek.command, command_id: "host-low", expected_control_epoch: undefined } }, piece(), piece(1), commit, failure, ...controls, feedback("first_sample"), feedback("exited"), feedback("spawned", { piece_index: 1, player_instance_id: "player-2" }), feedback("spawned", { piece_index: 2 }), feedback("spawned"), feedback("first_sample", { control_epoch: 2 }),
    feedback("first_sample", { piece_index: 1, player_instance_id: "player-2" }), feedback("exited", { piece_index: 1, player_instance_id: "player-2" }), feedback("exited", { piece_index: 1, control_epoch: 2 }), feedback("exited", { piece_index: 1, control_epoch: 2, exit: { status: "failed", stopped_at_ms: 0 } }),
    feedback("first_sample", {}, { ...identity, owner_epoch: 2 }), feedback("first_sample", {}, { ...identity, attempt_id: "attempt-2" }), feedback("first_sample", {}, { ...identity, session_id: "session-2" }), feedback("first_sample", { session_id: "foreign", control_epoch: 0 }),
    { ...seek, command: { ...seek.command, session_id: "missing" } }, toLast, { ...seek, command: { ...seek.command, command_id: "seek-2" } }, { ...seek, command: { ...seek.command, session_id: "session-2" } }, { kind: "reanchor", session_id: identity.session_id, reason: "speed", target: current }, { kind: "reanchor", session_id: identity.session_id, reason: "restart", target: { ...current, control_epoch: 3 } }];
  const bare = run(accepted(2), second), ready = run(bare, piece(), piece(1)), host = run(accepted(2, "host"), second, piece(), piece(1));
  let frontier = new Map<string, { state: State; paths: number }>([bare, ready, host].map(state => [JSON.stringify(state), { state, paths: 1 }]));
  const distinct = new Set<string>(); let visits = 0, scripts = 3; const start = performance.now();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  function check(before: State, input: Input, after: State, effects: ReturnType<typeof reduce>["effects"]) {
    const id = input.kind === "control" ? input.command.session_id : identity.session_id;
    const a = before.sessions[id], b = after.sessions[id], emitted = effects.flatMap(e => e.kind === "emit" ? [e.event] : []);
    if (emitted.some((e, i) => !("seq" in e) || e.seq !== before.seq + i + 1) || after.seq !== before.seq + emitted.length) throw Error("seq");
    if (!a) { if (!emitted.some(e => e.type === "error" && e.code === "UNKNOWN_SESSION")) throw Error("unknown session"); return; }
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
      const epochOK = a.epoch_authority === "host" ? f.control_epoch >= a.current.control_epoch : f.control_epoch === a.current.control_epoch;
      const spawnOK = f.edge === "spawned" && [a.current.piece_index, a.current.piece_index + 1].includes(f.piece_index) && a.delivered.some(p => p.index === f.piece_index);
      if (epochOK && (spawnOK || (f.piece_index === a.current.piece_index && f.player_instance_id === a.current.player_instance_id)) && a.epoch_authority === "host" && b.current.control_epoch !== f.control_epoch) throw Error("host feedback epoch");
      if (epochOK && spawnOK && (b.current.player_instance_id !== f.player_instance_id || b.current.piece_index !== f.piece_index)) throw Error("live job");
      if ((!epochOK || (!spawnOK && f.player_instance_id !== a.current.player_instance_id)) && !emitted.some(e => e.type === "error" && e.code === "STALE_EPOCH")) throw Error("ID-01");
      if (epochOK && !spawnOK && f.piece_index !== a.current.piece_index && !same(a, b)) throw Error("piece guard");
    }
    if (input.kind === "reanchor" && !a.outcome && a.playback === null) {
      const expected = a.epoch_authority === "engine" ? a.current.control_epoch + 1 : input.target.control_epoch;
      if (input.target.control_epoch >= a.current.control_epoch || a.epoch_authority === "engine") { if (b.current.control_epoch !== expected) throw Error("epoch authority"); }
      else if (!emitted.some(e => e.type === "error" && e.code === "STALE_EPOCH")) throw Error("host stale anchor");
    }
    if (input.kind === "control") {
      const receipt = a.receipts.find(r => r.command.command_id === input.command.command_id);
      if (receipt && same(receipt.command, input.command)) { if (!same(before, after) || effects[0]?.kind !== "replay") throw Error("idempotency"); }
      const stale = input.command.op !== "stop" && ((input.command.expected_control_epoch !== undefined && input.command.expected_control_epoch !== a.current.control_epoch) || (a.epoch_authority === "host" && input.target.control_epoch < a.current.control_epoch));
      if (!receipt && stale && !emitted.some(e => e.type === "control_ack" && e.reason === "STALE_EPOCH")) throw Error("control fence");
    }
    if (input.kind === "control" && input.command.op === "stop" && a.generation === "running" && !a.outcome && a.playback === null && !a.receipts.some(r => r.command.command_id === input.command.command_id)) {
      if (!b.fenced || b.generation !== "cancelled") throw Error("I03 cancellation / stop wins");
    }
  }
  for (let depth = 0; depth <= 4; depth++) {
    const next = new Map<string, { state: State; paths: number }>();
    for (const [k, { state, paths }] of frontier) {
      visits++; distinct.add(k); if (depth === 4) continue;
      for (const input of alphabet) {
        const r = reduce(state, input); check(state, input, r.state, r.effects); scripts += paths;
        const key = JSON.stringify(r.state), old = next.get(key); next.set(key, { state: r.state, paths: paths + (old?.paths ?? 0) });
      }
    }
    frontier = next;
  }
  console.log(`exhaustive depth=4 alphabet=${alphabet.length} scripts=${scripts} visits=${visits} distinct=${distinct.size} wall_ms=${(performance.now() - start).toFixed(1)}`);
  expect(scripts).toBe(3 * (1 + alphabet.length + alphabet.length ** 2 + alphabet.length ** 3 + alphabet.length ** 4));
}, 20000);

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initialState, reduce, type State, type Input } from "../../../src/engine/reducer/session";
import type { Message } from "../../../src/engine/messages/messages";
const identity = { owner_epoch: 1, session_id: "session-1", attempt_id: "attempt-1" };
const current = { session_id: identity.session_id, player_instance_id: "player-1", control_epoch: 1, audio_ms: 0, piece_index: 0, piece_start_ms: 0, piece_duration_ms: 10, duration_ms: 10 };
const request: Message<"narrate"> = { protocol: "nl.engine/1", type: "narrate", request_id: "req-1", idempotency_key: "key", use: "read", input: { text: "Synthetic words only", format: "plain" }, voice: { profile: "fake", require_clone: false, fallback: "none" }, delivery: "pieces" };
function accepted(n = 1): State {
  const plan = { type: "plan", session_id: identity.session_id, attempt_id: identity.attempt_id, display_document: { version: 1, text: "Synthetic", speech_start: 0, blocks: [] }, words: [], pieces: Array.from({ length: n }, (_, index) => ({ piece_id: `p${index}`, index, word_start: 0, word_end: 0, raw: false, segments: [] })), engine: { family: "fake", profile_revision: "1", voice: "fake" } } satisfies Omit<Message<"plan">, "protocol" | "owner_epoch" | "seq">;
  return reduce(initialState(identity, current), { kind: "accept", request, plan }).state;
}
function piece(index = 0): Input {
  return { kind: "backend", identity, result: { kind: "piece", piece: { type: "piece_ready", session_id: identity.session_id, attempt_id: identity.attempt_id, piece_id: `p${index}`, index, start_ms: index * 10, duration_ms: 10, spoken_text: "Synthetic", artifact: { handle: "h", lease_id: "l", format: "wav", sample_rate: 1, sample_count: 1, sha256: "synthetic" }, words: [], actual: [], synthesis: { rate: "1", attempts: [], unavailable: [], fallback_reason: null }, synthesis_ms: 0 } } };
}
const commit: Input = { kind: "backend", identity, result: { kind: "commit" } }, failure: Input = { kind: "backend", identity, result: { kind: "failure" } }, stop: Input = { kind: "stop", reason: "stop" };
function feedback(edge: Message<"player_feedback">["edge"], overrides: Partial<Message<"player_feedback">> = {}, id = identity): Input {
  return { kind: "feedback", identity: id, feedback: { protocol: "nl.engine/1", type: "player_feedback", session_id: identity.session_id, player_instance_id: "player-1", control_epoch: 1, piece_index: 0, t_mono_ms: 0, edge, ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: 10 } } : {}), ...overrides } };
}
const seek = { kind: "control", command: { protocol: "nl.engine/1", type: "control", command_id: "seek-1", session_id: identity.session_id, expected_control_epoch: 1, op: "seek", args: { audio_ms: 0 } }, target: current } satisfies Input;
const run = (s: State, ...inputs: Input[]) => inputs.reduce((v, i) => reduce(v, i).state, s);
test("I01: first terminals win in either order; publication failure preserves EOF", () => {
  const ready = run(accepted(), piece(), feedback("first_sample"));
  const ended = run(ready, feedback("exited"), failure);
  expect([ended.playback, ended.generation, ended.outcome?.playback.reason]).toEqual(["completed", "failed", "completed"]);
  for (const inputs of [[stop, feedback("exited"), failure], [failure, feedback("exited"), stop]]) {
    const first = run(ready, inputs[0]); expect(run(first, ...inputs.slice(1))).toEqual(first);
  }
  const committed = run(ready, commit); expect(run(committed, failure).generation).toBe("committed");
  const eofThenStop = run(ready, feedback("exited"), stop); expect(eofThenStop.playback).toBe("completed");
});
test("I02: matching feedback moves state; foreign job owner and attempt cannot", () => {
  const s = run(accepted(), piece()); expect(run(s, feedback("first_sample")).started).toBe(true);
  for (const id of [{ ...identity, session_id: "session-2" }, { ...identity, owner_epoch: 2 }, { ...identity, attempt_id: "attempt-2" }]) expect(run(s, feedback("first_sample", {}, id))).toEqual(s);
  const sought = run(s, seek); expect(run(sought, feedback("exited", {}, { ...identity, owner_epoch: 2 }))).toEqual(sought);
});
test("I03: cancellation fences delivery and commit, including late backend results", () => {
  expect(run(accepted(), piece(), commit).generation).toBe("committed");
  const cancelled = run(accepted(2), piece(), stop);
  expect(run(cancelled, piece(1), commit, failure)).toEqual(cancelled);
});
test("I04: natural EOF needs actual start and N-piece coverage; partial EOF races", () => {
  for (const n of [1, 2, 5]) {
    let s = accepted(n); s = run(s, ...Array.from({ length: n }, (_, i) => piece(i)));
    const final = { ...current, piece_index: n - 1, control_epoch: 2 };
    s = run(s, { ...seek, target: final });
    expect(run(s, feedback("exited", { piece_index: n - 1, control_epoch: 2 })).playback).toBeNull();
    s = run(s, feedback("first_sample", { piece_index: n - 1, control_epoch: 2 }));
    expect(run(s, feedback("exited", { piece_index: n - 1, control_epoch: 2 }), commit).outcome?.playback.reason).toBe("completed");
  }
  let s = run(accepted(2), piece(), feedback("first_sample"));
  expect(run(s, commit).generation).toBe("running");
  s = { ...s, current: { ...current, piece_index: 1 } };
  expect(run(s, feedback("exited", { piece_index: 1 })).playback).toBeNull();
  expect(run(s, feedback("exited", { piece_index: 1 }), failure).playback).toBe("speech_failed");
});
test("ID-01 fence (no model backing): stale feedback and controls after seek carry current", () => {
  const s = run(accepted(), piece(), feedback("first_sample"), seek);
  for (const f of [feedback("exited"), feedback("exited", { control_epoch: 2, player_instance_id: "old-player" })]) {
    expect(reduce(s, f).effects).toEqual([{ kind: "reject", code: "STALE_EPOCH", current: s.current }]); expect(run(s, f)).toEqual(s);
  }
  if (seek.kind !== "control") throw Error("fixture");
  const rejected = reduce(s, { ...seek, command: { ...seek.command, command_id: "seek-2" } });
  expect(rejected.effects[0]).toEqual({ kind: "reject", code: "STALE_EPOCH", current: s.current });
  expect(run(s, feedback("exited", { control_epoch: 2 }), commit).outcome?.playback.reason).toBe("completed");
  expect(reduce(s, { ...seek, command: { ...seek.command, session_id: "missing" } }).effects[0]).toEqual({ kind: "reject", code: "UNKNOWN_SESSION", current: s.current });
});
test("seq: every fresh event advances exactly one and plan precedes backend", () => {
  const s = accepted(); expect(s.seq).toBe(2);
  const first = reduce(initialState(identity, current), { kind: "accept", request, plan: s.plan! });
  expect(first.effects.map(e => e.kind === "emit" ? e.event.type : e.kind)).toEqual(["accepted", "plan", "backend"]);
  const r = reduce(s, piece()); expect(r.effects[0]).toMatchObject({ kind: "emit", event: { seq: 3, type: "piece_ready" } });
  expect(run(r.state, feedback("first_sample"), feedback("exited"), commit).seq).toBe(4);
});
test("idempotency: first ack replays without state changes; changed args rejected; 32 receipts", () => {
  const s = run(accepted(), seek), replay = reduce(s, seek);
  expect(replay.state).toEqual(s); expect(replay.effects).toEqual([{ kind: "replay", event: s.receipts[0].ack }]);
  if (seek.kind !== "control") throw Error("fixture");
  expect(reduce(s, { ...seek, command: { ...seek.command, args: { audio_ms: 1 } } }).effects).toContainEqual(expect.objectContaining({ kind: "emit", event: expect.objectContaining({ reason: "command id reused" }) }));
  let many = accepted(); for (let i = 0; i < 33; i++) many = run(many, { ...seek, command: { ...seek.command, command_id: `c${i}`, expected_control_epoch: undefined } });
  expect(many.receipts).toHaveLength(32);
});
test("purity: imports limited to message types; serialised state reduces identically", () => {
  const source = readFileSync("src/engine/reducer/session.ts", "utf8");
  expect([...source.matchAll(/(?:from|import\s*\()\s*["']([^"']+)/g)].map(m => m[1])).toEqual(["../messages/messages"]);
  const s = run(accepted(), piece(), seek); expect(reduce(JSON.parse(JSON.stringify(s)), stop)).toEqual(reduce(s, stop));
  const before = JSON.stringify(s); reduce(s, stop); expect(JSON.stringify(s)).toBe(before);
});
test("exhaustive: I01 I02 I03 I04 for every script through length 6", () => {
  const alphabet = [piece(), commit, failure, stop, feedback("first_sample"), feedback("exited"), feedback("first_sample", {}, { ...identity, owner_epoch: 2 }), feedback("exited", {}, { ...identity, session_id: "session-2" }), seek];
  let visits = 0; const unique = new Set<string>();
  function visit(s: State, depth: number) {
    visits++; unique.add(JSON.stringify(s)); if (!depth) return;
    for (const input of alphabet) {
      const next = reduce(s, input).state;
      if (s.outcome && JSON.stringify(next.outcome) !== JSON.stringify(s.outcome)) throw Error("I01 outcome");
      if (s.generation !== "running" && next.generation !== s.generation) throw Error("I01 generation");
      if (s.playback !== null && next.playback !== s.playback) throw Error("I01 playback");
      if (input.kind === "feedback" && (input.identity.owner_epoch !== s.owner_epoch || input.identity.session_id !== s.session_id)) { if (JSON.stringify(next) !== JSON.stringify(s)) throw Error("I02"); }
      if (s.fenced && (JSON.stringify(next.delivered) !== JSON.stringify(s.delivered) || next.generation === "committed")) throw Error("I03");
      if (next.playback === "completed" && (!next.eof || !next.started || next.delivered.length !== next.plan!.pieces.length)) throw Error("I04 playback");
      if (next.generation === "committed" && next.delivered.length !== next.plan!.pieces.length) throw Error("I04 generation");
      visit(next, depth - 1);
    }
  }
  visit(accepted(), 6); console.log(`exhaustive visits=${visits} distinct=${unique.size}`);
  expect(visits).toBe(597871);
}, 30000);

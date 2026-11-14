import type { Case, CaseContext } from "./runner";
import type { BackendStep, Json } from "./binding";
import { pcmAudio, ScriptedBackend } from "./fake-backend";
import { ScriptedPlayer, ScriptedSpawn } from "./fake-player";
import { ScriptedHost } from "./host-stub";
import { parseEvent } from "../messages/parser";
import type { Event } from "../messages/messages";
export const hello = { protocol: "nl.engine/1", type: "hello", client: { name: "synthetic", version: "1" }, binding: "in-process", stage: "A", required_caps: [] } satisfies Json;
const read = (id = "request-1", key = id, text = "Copper boats drift.") => ({ protocol: "nl.engine/1", type: "narrate", request_id: id, idempotency_key: key, use: "read", input: { text, format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" } satisfies Json);
const audio = (late_after_cancel = false): BackendStep => ({ latency_ms: 1, late_after_cancel, result: { kind: "audio", ...pcmAudio(100, 1000, 300) } });
function setup(c: CaseContext, steps: BackendStep[]) {
  const backend = new ScriptedBackend(c.clock), spawn = new ScriptedSpawn(c.clock), player = new ScriptedPlayer(c.clock, spawn);
  backend.script(steps);
  const connection = c.binding.create({ clock: c.clock, ports: { backend, player, spawn, host: new ScriptedHost(c.clock) }, store: new Map(), hash_key: new Uint8Array(32).fill(1), audible: false });
  const seen: Event[] = [];
  const collect = (async () => { for await (const event of connection.events) { const parsed = parseEvent(event); c.assert(parsed.ok); if (parsed.ok && parsed.value) seen.push(parsed.value); } })().catch(() => { c.failed = true; });
  const settle = async (ms = 0) => { await c.clock.advance(ms); for (let i = 0; i < 128; i++) await Promise.resolve(); };
  connection.send(hello);
  return { connection, seen, backend, settle,
    async finish() { await connection.shutdown(c.clock.now()); await settle(); await collect; backend.assertDrained(); player.assertDrained(); spawn.assertDrained(); } };
}
function stop(connection: ReturnType<typeof setup>["connection"], session_id: string) {
  connection.send({ protocol: "nl.engine/1", type: "control", command_id: "stop-command", session_id, op: "stop", args: { scope: "session", reason: "stop" } });
}
export const engineCases: Record<string, Case> = {
  "PLAN-LAT-01": async c => {
    // Repeat with shutdown at each call, so the second request needs its own plan too.
    for (const target of [1, 2]) {
      const backend = new ScriptedBackend(c.clock), spawn = new ScriptedSpawn(c.clock), player = new ScriptedPlayer(c.clock, spawn);
      backend.script(Array.from({ length: target }, () => audio()));
      const original = backend.synthesizeRequest.bind(backend);
      const connection = c.binding.create({ clock: c.clock, ports: { backend, player, spawn, host: new ScriptedHost(c.clock) }, store: new Map(), hash_key: new Uint8Array(32), audible: false });
      const seen: Event[] = [];
      const collect = (async () => { for await (const event of connection.events) { const parsed = parseEvent(event); c.assert(parsed.ok); if (parsed.ok && parsed.value) seen.push(parsed.value); } })().catch(() => { c.failed = true; });
      connection.send(hello);
      let calls = 0;
      backend.synthesizeRequest = (request, signal) => {
        if (++calls === target) {
          void connection.shutdown(c.clock.now());
          connection.send(read("request-sentinel")); // A deferred shutdown wrongly admits this.
        }
        return original(request, signal);
      };
      const texts = ["Copper boats drift.", "Silver kites rise."];
      for (let i = 0; i < target; i++) connection.send(read(`request-${i + 1}`, `key-${i + 1}`, texts[i]));
      await collect; await c.clock.advance(1);
      c.assert(backend.calls.length === target);
      c.assert(!seen.some(e => "request_id" in e && e.request_id === "request-sentinel"));
      for (let i = 0; i < target; i++) {
        const accepted = seen.find(e => e.type === "accepted" && e.request_id === `request-${i + 1}`);
        c.assert(accepted?.type === "accepted");
        if (accepted?.type !== "accepted") continue;
        const plan = seen.findIndex(e => e.type === "plan" && e.session_id === accepted.session_id);
        const outcome = seen.findIndex(e => e.type === "outcome" && e.session_id === accepted.session_id);
        const request = backend.calls[i];
        c.assert(request !== null && typeof request === "object" && !Array.isArray(request) && request.text === texts[i]);
        c.assert(plan >= 0 && outcome > plan);
      }
      backend.assertDrained(); player.assertDrained(); spawn.assertDrained();
    }
  },
  "ORDER-01": async c => {
    const t = setup(c, [audio()]); t.connection.send(read()); await t.settle(1);
    const accepted = t.seen.find(e => e.type === "accepted"); c.assert(accepted?.type === "accepted");
    if (accepted?.type !== "accepted") return;
    for (const edge of ["spawned", "first_sample", "last_sample", "exited"]) t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: accepted.session_id, control_epoch: 1, player_instance_id: "synthetic-player", piece_index: 0, edge, t_mono_ms: c.clock.now(), source: "player_reported", ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: 100 } } : {}) });
    await t.settle();
    const named = t.seen.filter(e => ["accepted", "plan", "piece_ready", "outcome"].includes(e.type));
    c.assert(named.map(e => e.type).join() === "accepted,plan,piece_ready,outcome");
    const outcome = t.seen.find(e => e.type === "outcome"); c.assert(outcome?.type === "outcome" && outcome.playback.reason === "completed" && outcome.generation.status === "committed");
    await t.finish();
    let seq = 0;
    for (const event of t.seen) if (event.type !== "welcome") c.assert(event.seq === ++seq);
    c.assert(t.seen.at(-1)?.type === "outcome"); // Lease-backed timing_update exception owed to S7.
  },
  "ERR-01": async c => {
    const t = setup(c, [{ latency_ms: 1, late_after_cancel: false, result: { kind: "error", code: "synthetic failure" } }]);
    t.connection.send(read()); await t.settle(1); await t.finish();
    const errors = t.seen.filter(e => e.type === "error"), outcomes = t.seen.filter(e => e.type === "outcome");
    c.assert(errors.length === 1 && errors[0].code === "SYNTH_FAILED" && errors[0].phase === "synthesize" && errors[0].retry === "new_request");
    const accepted = t.seen.find(e => e.type === "accepted");
    c.assert(accepted?.type === "accepted" && errors[0].session_id === accepted.session_id);
    const diagnostic = JSON.stringify(errors.map(e => ({ message: e.message, details: e.details })));
    const text = "Copper boats drift.";
    for (let i = 0; i <= text.length - 8; i++) c.assert(!diagnostic.includes(text.slice(i, i + 8)));
    c.assert(outcomes.length === 1 && outcomes[0].playback.reason === "synth_failed" && outcomes[0].generation.status === "failed");
    c.assert(t.seen.indexOf(errors[0]) < t.seen.indexOf(outcomes[0]) && t.seen.at(-1) === outcomes[0]);
  },
  "ID-03": async c => {
    const t = setup(c, [audio(true)]); t.connection.send(read()); await t.settle();
    const accepted = t.seen.find(e => e.type === "accepted"); c.assert(accepted?.type === "accepted");
    if (accepted?.type !== "accepted") return;
    stop(t.connection, accepted.session_id); await t.settle();
    c.assert(t.seen.some(e => e.type === "control_ack" && e.command_id === "stop-command"));
    const outcomes = t.seen.filter(e => e.type === "outcome");
    c.assert(outcomes.length === 1 && outcomes[0].session_id === accepted.session_id);
    const count = t.seen.length; await t.settle(2); c.assert(t.seen.length === count);
    c.assert(!t.seen.some(e => e.type === "piece_ready")); await t.finish();
  },
  "ID-04": async c => {
    const t = setup(c, [audio(), audio()]);
    t.connection.send(read()); t.connection.send(read("request-2")); await t.settle(1);
    const first = t.seen.filter(e => e.type === "accepted"); c.assert(first.length === 2 && first[0].session_id !== first[1].session_id);
    const plans = t.seen.filter(e => e.type === "plan").length;
    t.connection.send(read()); await t.settle();
    c.assert(plans === 2 && t.seen.filter(e => e.type === "plan").length === plans);
    const accepted = t.seen.filter(e => e.type === "accepted");
    c.assert(accepted.length === 3 && JSON.stringify(accepted[0]) === JSON.stringify(accepted[2]));
    t.connection.send(read("request-1", "request-1", "Silver kites rise.")); await t.settle();
    const conflicts = t.seen.filter(e => e.type === "error" && e.code === "IDEMPOTENCY_CONFLICT");
    c.assert(conflicts.length === 1 && conflicts[0].type === "error" && conflicts[0].phase === "admit" && conflicts[0].retry === "never");
    c.assert(t.backend.calls.length === 2); await t.finish();
  },
  "TIME-02": async c => {
    const t = setup(c, [audio()]); t.connection.send(read()); await t.settle(1); await t.finish();
    const pieces = t.seen.filter(e => e.type === "piece_ready"); c.assert(pieces.length === 1);
    for (const piece of pieces) { c.assert(piece.duration_ms === 100 && piece.start_ms === 0); c.assert(piece.artifact.sample_count === 100 && piece.artifact.sample_rate === 1000); c.assert(piece.words.every(w => w.start_ms >= 0 && w.end_ms <= 100)); }
    for (const event of t.seen) {
      if (event.type === "duration") c.assert(event.known_ms === 100);
      if (event.type === "lifecycle" && event.edge === "audio_ready") c.assert(event.duration_ms === 100);
    }
  },
};

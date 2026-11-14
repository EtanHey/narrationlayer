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
async function bounded(c: CaseContext, promise: Promise<unknown>) {
  let done = false, error: unknown;
  void promise.then(() => { done = true; }, e => { error = e; done = true; });
  for (let i = 0; i < 8 && !done; i++) { await c.clock.advance(1); for (let j = 0; j < 128; j++) await Promise.resolve(); }
  c.assert(done); if (error) throw error;
}
function setup(c: CaseContext, steps: BackendStep[]) {
  const backend = new ScriptedBackend(c.clock), spawn = new ScriptedSpawn(c.clock), player = new ScriptedPlayer(c.clock, spawn);
  backend.script(steps);
  const connection = c.binding.create({ clock: c.clock, ports: { backend, player, spawn, host: new ScriptedHost(c.clock) }, store: new Map(), hash_key: new Uint8Array(32).fill(1), audible: false });
  const seen: Event[] = [];
  const collect = (async () => { for await (const event of connection.events) { const parsed = parseEvent(event); c.assert(parsed.ok); if (parsed.ok && parsed.value) seen.push(parsed.value); } })().catch(() => { c.failed = true; });
  const settle = async (ms = 0) => { await c.clock.advance(ms); for (let i = 0; i < 128; i++) await Promise.resolve(); };
  connection.send(hello);
  return { connection, seen, backend, settle,
    async finish() { await bounded(c, connection.shutdown(c.clock.now())); await settle(); await bounded(c, collect); backend.assertDrained(); player.assertDrained(); spawn.assertDrained(); } };
}
function stop(connection: ReturnType<typeof setup>["connection"], session_id: string) {
  connection.send({ protocol: "nl.engine/1", type: "control", command_id: "stop-command", session_id, op: "stop", args: { scope: "session", reason: "stop" } });
}
const multiText = "Amber rafts float. Violet cranes glide. Golden otters swim.";
const shapes = [[1, 2500], [1, 10000], [7, 4800]];
const steps = (scale = 1): BackendStep[] => shapes.map(([count, rate], i) => ({ latency_ms: i + 2, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(count * scale, rate, 999), sample_rate: 8000 } }));
async function multi(c: CaseContext, script = steps()) {
  const t = setup(c, script);
  t.connection.send({ ...read("request-multi", "key-multi", multiText), lookahead: 3 });
  for (let i = 0; i < 24; i++) await t.settle(1);
  return t;
}
function complete(t: ReturnType<typeof setup>, c: CaseContext) {
  const accepted = t.seen.find(e => e.type === "accepted"); c.assert(accepted?.type === "accepted");
  if (accepted?.type !== "accepted") return;
  for (const piece of t.seen.filter(e => e.type === "piece_ready"))
    for (const edge of ["spawned", "first_sample", "first_audible", "last_sample", "exited"])
      t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: accepted.session_id, control_epoch: piece.index + 1, player_instance_id: `synthetic-${piece.index}`, piece_index: piece.index, edge, t_mono_ms: c.clock.now(), source: "player_reported", ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: piece.start_ms + piece.duration_ms } } : {}) });
}
// Independent rational sum: round once, with exact ties upward.
function cumulative(count: number, scale = 1) {
  let numerator = 0n, denominator = 1n;
  for (const [samples, rate] of shapes.slice(0, count)) {
    numerator = numerator * BigInt(rate) + BigInt(samples * scale * 1000) * denominator;
    denominator *= BigInt(rate);
  }
  return Number((2n * numerator + denominator) / (2n * denominator));
}
export const engineCases: Record<string, Case> = {
  "GEN-02": async c => {
    const t = await multi(c); complete(t, c); await t.settle(); await t.finish();
    const plan = t.seen.filter(e => e.type === "plan"), pieces = t.seen.filter(e => e.type === "piece_ready"), durations = t.seen.filter(e => e.type === "duration");
    c.assert(plan.length === 1 && plan[0].pieces.length === 3 && pieces.length === 3);
    c.assert(pieces.every((p, i) => p.index === i && p.piece_id === plan[0].pieces[i].piece_id && p.session_id === plan[0].session_id && t.seen.indexOf(plan[0]) < t.seen.indexOf(p)));
    const final = durations.filter(e => e.final); c.assert(final.length === 1);
    c.assert(pieces.every(p => t.seen.indexOf(p) < t.seen.indexOf(final[0])));
    c.assert(durations.length >= 1 && durations.every((e, i) => e.session_id === plan[0].session_id && (i === 0 || e.known_ms >= durations[i - 1].known_ms)));
  },
  "LIFE-01e": async c => {
    for (const failed of [false, true]) {
      const script = failed ? [steps()[0], { latency_ms: 3, late_after_cancel: false, result: { kind: "error", code: "invented failure" } } satisfies BackendStep] : steps();
      const t = await multi(c, script);
      if (!failed) complete(t, c);
      await t.settle(); await t.finish();
      const pieces = t.seen.filter(e => e.type === "piece_ready"), records = t.seen.filter(e => e.type === "lifecycle");
      c.assert(pieces.length === (failed ? 1 : 3));
      c.assert(records.length === (failed ? 3 : 6));
      const accepted = t.seen.find(e => e.type === "accepted");
      c.assert(accepted?.type === "accepted" && records.every(r => r.session_id === accepted.session_id));
      c.assert(t.seen.some(e => e.type === "welcome" && e.caps.includes("lifecycle")));
      for (let i = 0; i < (failed ? 2 : 3); i++) {
        const requested = records.filter(e => e.piece_index === i && e.edge === "synthesis_requested"), ready = records.filter(e => e.piece_index === i && e.edge === "audio_ready");
        c.assert(requested.length === 1 && ready.length === (failed && i === 1 ? 0 : 1));
        const piece = pieces[i], r = ready[0];
        if (piece) c.assert(r?.edge === "audio_ready" && r.session_id === piece.session_id && requested[0].session_id === piece.session_id && requested[0].seq < r.seq && requested[0].t_mono_ms <= r.t_mono_ms && r.duration_ms === piece.duration_ms && r.sample_count === piece.artifact.sample_count);
      }
      c.assert(records.every((r, i) => i === 0 || r.t_mono_ms >= records[i - 1].t_mono_ms));
      const encoded = JSON.stringify(records);
      for (let i = 0; i <= multiText.length - 8; i++) c.assert(!encoded.includes(multiText.slice(i, i + 8)));
      const outcome = t.seen.findIndex(e => e.type === "outcome"); c.assert(outcome >= 0 && !t.seen.slice(outcome + 1).some(e => e.type === "lifecycle"));
    }
  },
  "TIME-01": async c => {
    const t = await multi(c); complete(t, c); await t.settle(); await t.finish();
    const pieces = t.seen.filter(e => e.type === "piece_ready"); c.assert(pieces.length === 3);
    c.assert(cumulative(2) !== shapes.slice(0, 2).reduce((sum, [n, r]) => sum + Math.round(n * 1000 / r), 0));
    pieces.forEach((p, i) => c.assert(p.index === i && p.start_ms === cumulative(i) && p.artifact.sample_rate === shapes[i][1] && p.artifact.sample_count === shapes[i][0]));
  },
  "GEN-01e": async c => {
    for (const failedIndex of [1, 0]) {
      const t = await multi(c, [...steps().slice(0, failedIndex), { latency_ms: 3, late_after_cancel: false, result: { kind: "error", code: "invented failure" } }]);
      await t.finish();
      const accepted = t.seen.find(e => e.type === "accepted"), errors = t.seen.filter(e => e.type === "error"), outcomes = t.seen.filter(e => e.type === "outcome"), pieces = t.seen.filter(e => e.type === "piece_ready");
      c.assert(accepted?.type === "accepted" && errors.length === 1 && errors[0].session_id === accepted.session_id && errors[0].code === "SYNTH_FAILED" && errors[0].phase === "synthesize" && errors[0].retry === "new_request");
      c.assert(outcomes.length === 1 && outcomes[0].session_id === accepted?.session_id && outcomes[0].playback.reason === (failedIndex ? "speech_failed" : "synth_failed") && outcomes[0].generation.status === "failed");
      c.assert(JSON.stringify(outcomes[0].missing_piece_indices) === JSON.stringify([0, 1, 2].slice(failedIndex)));
      c.assert(pieces.length === failedIndex && pieces.every((p, i) => p.index === i && t.seen.indexOf(p) < t.seen.indexOf(errors[0])) && t.seen.indexOf(errors[0]) < t.seen.indexOf(outcomes[0]));
      const diagnostic = JSON.stringify(errors);
      for (let i = 0; i <= multiText.length - 8; i++) c.assert(!diagnostic.includes(multiText.slice(i, i + 8)));
    }
  },
  "WORD-02": async c => {
    const t = await multi(c); complete(t, c); await t.settle(); await t.finish();
    const plans = t.seen.filter(e => e.type === "plan"), pieces = t.seen.filter(e => e.type === "piece_ready");
    c.assert(plans.length === 1 && pieces.length === 3);
    c.assert(JSON.stringify(pieces.flatMap(p => p.words.map(w => w.index))) === JSON.stringify(plans[0].words.map(w => w.index)));
    for (const p of pieces) c.assert(p.words.length > 0 && p.words.every((w, i) => Number.isFinite(w.start_ms) && Number.isFinite(w.end_ms) && w.timing === "estimated" && w.start_ms >= p.start_ms && w.end_ms >= w.start_ms && w.end_ms <= p.start_ms + p.duration_ms && (i === 0 || w.start_ms >= p.words[i - 1].end_ms)));
  },
  "DET-01": async c => {
    const t = setup(c, [...steps(12), ...steps(24)]);
    for (const scale of [12, 24]) {
      const start = t.seen.length;
      t.connection.send({ ...read(`request-det-${scale}`, `key-det-${scale}`, multiText), lookahead: 3 });
      for (let i = 0; i < 24; i++) await t.settle(1);
      const seen = t.seen.slice(start), pieces = seen.filter(e => e.type === "piece_ready"), durations = seen.filter(e => e.type === "duration");
      c.assert(pieces.length === 3 && durations.length >= 3 && durations.every(d => shapes.some((_, i) => d.known_ms === cumulative(i + 1, scale))));
      pieces.forEach((p, i) => {
        const duration = Math.round(shapes[i][0] * scale * 1000 / shapes[i][1]);
        c.assert(p.start_ms === cumulative(i, scale) && p.duration_ms === duration && p.artifact.sample_count === shapes[i][0] * scale);
        c.assert(p.words.length === 3 && p.words.every((w, j) => w.start_ms === p.start_ms + Math.round(j * duration / 3) && w.end_ms === p.start_ms + Math.round((j + 1) * duration / 3)));
        c.assert(durations.some(d => d.known_ms === cumulative(i + 1, scale)));
      });
    }
    await t.finish();
  },
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
      for (let i = 0; i < 8 && calls < target; i++) await c.clock.advance(1);
      if (calls < target) await bounded(c, connection.shutdown(c.clock.now()));
      await bounded(c, collect); await c.clock.advance(1);
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

import { privacyCases } from "./privacy-cases";
import { pacingCases } from "./pacing-cases";
import { artifactCases } from "./artifact-cases";
import { negotiationCases } from "./negotiation-cases";
import type { Case, CaseContext } from "./runner";
import type { Binding, BackendStep, Json } from "./binding";
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
// Every fixture checks host work at the send/shutdown boundary, including work
// reached indirectly through an abort listener on a host backend.
export function createProbed(c: CaseContext, host: Parameters<Binding["create"]>[0]) {
  let depth = 0;
  const violations: string[] = [];
  const record = (name: string) => { if (depth) { violations.push(name); c.failed = true; } };
  for (const method of ["get", "set", "has", "delete"] as const) {
    const original = host.store[method].bind(host.store);
    Reflect.set(host.store, method, (...args: unknown[]) => {
      record(`store.${method}`); return Reflect.apply(original, host.store, args);
    });
  }
  if (host.ports) {
    const backend = host.ports.backend;
    host = { ...host, ports: { ...host.ports, backend: {
      script: steps => backend.script(steps),
      get calls() { return backend.calls; },
      synthesizeRequest(request, signal) { record("backend.synthesizeRequest"); return backend.synthesizeRequest(request, signal); },
    } } };
  }
  const schedule = host.clock.schedule.bind(host.clock);
  host.clock.schedule = (delay, callback) => { record("clock.schedule"); return schedule(delay, callback); };
  const connection = c.binding.create(host), send = connection.send.bind(connection), shutdown = connection.shutdown.bind(connection);
  connection.send = message => { depth++; try { send(message); } finally { depth--; } };
  connection.shutdown = deadline => {
    depth++;
    try { return shutdown(deadline).then(() => {
      if (violations.length) throw new Error(`host work inside send/shutdown: ${violations.join(", ")}`);
      c.assert(violations.length === 0);
    }); } finally { depth--; }
  };
  return connection;
}
export function setup(c: CaseContext, steps: BackendStep[]) {
  const backend = new ScriptedBackend(c.clock), spawn = new ScriptedSpawn(c.clock), player = new ScriptedPlayer(c.clock, spawn);
  backend.script(steps);
  const connection = createProbed(c, { clock: c.clock, ports: { backend, player, spawn, host: new ScriptedHost(c.clock) }, store: new Map(), hash_key: new Uint8Array(32).fill(1), audible: false });
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
async function multi(c: CaseContext, script = steps(), text = multiText) {
  const t = setup(c, script);
  t.connection.send({ ...read("request-multi", "key-multi", text), lookahead: 3 });
  for (let i = 0; i < 24; i++) await t.settle(1);
  return t;
}
function complete(t: ReturnType<typeof setup>, c: CaseContext, request_id?: string) {
  const accepted = t.seen.filter(e => e.type === "accepted").find(e => !request_id || e.request_id === request_id); c.assert(accepted?.type === "accepted");
  if (accepted?.type !== "accepted") return;
  for (const piece of t.seen.filter(e => e.type === "piece_ready").filter(e => e.session_id === accepted.session_id))
    for (const edge of ["spawned", "first_sample", "first_audible", "last_sample", "exited"])
      t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: accepted.session_id, control_epoch: piece.index + 1, player_instance_id: `synthetic-${piece.index}`, piece_index: piece.index, edge, t_mono_ms: c.clock.now(), source: "player_reported", ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: piece.start_ms + piece.duration_ms } } : {}) });
}
// Independent rational sum; half-up is the engine's documented tie rule.
function cumulative(count: number, scale = 1, audioShapes = shapes) {
  let numerator = 0n, denominator = 1n;
  for (const [samples, rate] of audioShapes.slice(0, count)) {
    numerator = numerator * BigInt(rate) + BigInt(samples * scale * 1000) * denominator;
    denominator *= BigInt(rate);
  }
  return Number((2n * numerator + denominator) / (2n * denominator));
}
// The backend port has no session id. Pair its ordered calls with the ordered
// synthesis_requested records, including failed/cancelled attempts without audio.
export function assertBackendCalls(c: CaseContext, seen: Event[], calls: readonly Json[], session_id: string, pieces: MessagePieces, undelivered = 0) {
  const requested = seen.filter(e => e.type === "lifecycle" && e.edge === "synthesis_requested");
  c.assert(calls.length === requested.length);
  c.assert(requested.every(r => seen.some(e => e.type === "accepted" && e.session_id === r.session_id)));
  const own = requested.flatMap((r, i) => r.session_id === session_id ? [calls[i]] : []);
  c.assert(own.length === pieces.length + undelivered);
  own.forEach((call, i) => c.assert(call !== null && typeof call === "object" && !Array.isArray(call) && call.piece_index === i && typeof call.text === "string" && (i >= pieces.length || call.text === pieces[i].spoken_text)));
  return own;
}
// Plain-text reads: every call (delivered or not) speaks exactly its planned piece's words.
const planned = (plan: Extract<Event, { type: "plan" }>, i: number) => plan.words.slice(plan.pieces[i].word_start, plan.pieces[i].word_end).map(w => w.text).join(" ");
type MessagePieces = Extract<Event, { type: "piece_ready" }>[];
export function success(c: CaseContext, seen: Event[], request_id: string, count: number, calls: readonly Json[]) {
  const accepted = seen.filter(e => e.type === "accepted").filter(e => e.request_id === request_id);
  c.assert(accepted.length >= 1 && accepted.every(e => e.session_id === accepted[0].session_id));
  const session_id = accepted[0].session_id;
  const own = seen.filter(e => "session_id" in e && e.session_id === session_id);
  const plans = own.filter(e => e.type === "plan"), pieces = own.filter(e => e.type === "piece_ready");
  const records = own.filter(e => e.type === "lifecycle"), durations = own.filter(e => e.type === "duration"), outcomes = own.filter(e => e.type === "outcome");
  c.assert(plans.length === 1 && plans[0].pieces.length === count && pieces.length === count);
  c.assert(pieces.every((p, i) => p.index === i && p.piece_id === plans[0].pieces[i].piece_id && p.attempt_id === plans[0].attempt_id && own.indexOf(plans[0]) < own.indexOf(p)));
  c.assert(records.length === 2 * count && pieces.every(p => records.filter(r => r.piece_index === p.index && r.edge === "synthesis_requested").length === 1 && records.filter(r => r.piece_index === p.index && r.edge === "audio_ready").length === 1));
  const finals = durations.filter(d => d.final);
  c.assert(finals.length === 1 && pieces.every(p => own.indexOf(p) < own.indexOf(finals[0])));
  c.assert(durations.every((d, i) => own.indexOf(d) > own.indexOf(pieces[0]) && (i === 0 || d.known_ms >= durations[i - 1].known_ms) && (d.final || own.indexOf(d) < own.indexOf(finals[0]))));
  c.assert(outcomes.length === 1 && outcomes[0].generation.status === "committed");
  c.assert(!seen.some(e => e.type === "error"));
  assertBackendCalls(c, seen, calls, session_id, pieces).forEach((call, i) => c.assert((call as { text: string }).text === planned(plans[0], i)));
  c.assert(own.at(-1)?.type === "outcome"); // Live-lease timing_update exception is owed to alignment (S7).
  return { own, plans, pieces, records, durations, outcomes };
}
// These fixtures have exactly one attempted call without a delivered piece.
export function interrupted(c: CaseContext, seen: Event[], request_id: string, delivered: number, generation: "failed" | "cancelled" | "interrupted", calls: readonly Json[]) {
  const accepted = seen.filter(e => e.type === "accepted").filter(e => e.request_id === request_id);
  c.assert(accepted.length === 1);
  const own = seen.filter(e => "session_id" in e && e.session_id === accepted[0].session_id);
  const plans = own.filter(e => e.type === "plan"), pieces = own.filter(e => e.type === "piece_ready"), records = own.filter(e => e.type === "lifecycle"), durations = own.filter(e => e.type === "duration"), outcomes = own.filter(e => e.type === "outcome");
  c.assert(plans.length === 1 && pieces.length === delivered && pieces.every((p, i) => p.index === i && p.piece_id === plans[0].pieces[i].piece_id));
  c.assert(records.length === 2 * delivered + 1);
  for (let i = 0; i <= delivered; i++) {
    c.assert(records.filter(r => r.piece_index === i && r.edge === "synthesis_requested").length === 1);
    c.assert(records.filter(r => r.piece_index === i && r.edge === "audio_ready").length === (i < delivered ? 1 : 0));
  }
  // A failed/cancelled prefix has no final: that claim requires every planned piece.
  c.assert(durations.length === delivered && durations.every(d => !d.final));
  c.assert(outcomes.length === 1 && outcomes[0].generation.status === generation);
  assertBackendCalls(c, seen, calls, accepted[0].session_id, pieces, 1).forEach((call, i) => c.assert((call as { text: string }).text === planned(plans[0], i)));
  c.assert(own.at(-1)?.type === "outcome"); // Live-lease timing_update exception is owed to alignment (S7).
}
function textFree(c: CaseContext, text: string) {
  const raw = JSON.stringify(c.trace.filter(e => e && typeof e === "object" && !Array.isArray(e) && (e.type === "lifecycle" || e.type === "error")));
  for (let i = 0; i <= text.length - 8; i++) c.assert(!raw.includes(text.slice(i, i + 8)));
}
export const engineCases: Record<string, Case> = {
  ...privacyCases,
  "BIND-01": async c => {
    for (const reenter of [false, true]) {
      const backend = new ScriptedBackend(c.clock);
      let calls = 0, aborts = 0, depth = 0;
      backend.synthesizeRequest = (_request, signal) => {
        calls++;
        signal.addEventListener("abort", () => { aborts++; c.clock.schedule(0, () => {}); });
        return new Promise(() => {});
      };
      const spawn = new ScriptedSpawn(c.clock), player = new ScriptedPlayer(c.clock, spawn);
      const connection = createProbed(c, { clock: c.clock, ports: { backend, spawn, player, host: new ScriptedHost(c.clock) }, store: new Map(), hash_key: new Uint8Array(32), audible: false });
      const seen: Event[] = [];
      // Line 426: event consumption cannot nest a send on an outer send stack.
      const send = (message: Json) => { c.assert(depth === 0); depth++; try { connection.send(message); } finally { depth--; } };
      let ended = false;
      const collect = (async () => {
        for await (const raw of connection.events) {
          c.assert(depth === 0); // Line 426: no consumer runs inside send.
          const event = parseEvent(raw); c.assert(event.ok);
          if (!event.ok || !event.value) continue;
          seen.push(event.value);
          if (reenter && event.value.type === "accepted" && event.value.request_id === "bind-first") {
            send({ protocol: "nl.engine/1", type: "control", command_id: "bind-stop", session_id: event.value.session_id, op: "stop", args: { scope: "session", reason: "stop" } });
            send(read("bind-second"));
          }
        }
        ended = true;
      })().catch(() => { c.failed = true; ended = true; });
      send(hello); send(read("bind-first"));
      // Lines 425/426: neither work ports nor a consumer ran on send's stack.
      c.assert(calls === 0 && aborts === 0 && seen.length === 0);
      for (let i = 0; i < 64; i++) await Promise.resolve();
      await c.clock.advance(0);
      for (let i = 0; i < 64; i++) await Promise.resolve();
      // BIND-01: work starts; 425/426 do not fix the race with a consumer stop.
      c.assert(reenter ? calls >= 1 && calls <= 2 : calls === 1);
      // Admission queues exactly one acceptance and plan per fresh request (116).
      c.assert(seen.filter(e => e.type === "accepted" && e.request_id === "bind-first").length === 1);
      c.assert(seen.filter(e => e.type === "plan").length === (reenter ? 2 : 1));
      if (reenter) {
        const plan = seen.findIndex(e => e.type === "plan");
        const ack = seen.findIndex(e => e.type === "control_ack");
        const second = seen.findIndex(e => e.type === "accepted" && e.request_id === "bind-second");
        // Lines 114/116: queued plan precedes the inner stop ack, then admission.
        c.assert(plan >= 0 && ack > plan && second > ack);
      } else {
        const accepted = seen.find(e => e.type === "accepted"); c.assert(accepted?.type === "accepted");
        if (accepted?.type === "accepted") send({ protocol: "nl.engine/1", type: "control", command_id: "bind-stop", session_id: accepted.session_id, op: "stop", args: { scope: "session", reason: "stop" } });
        c.assert(aborts === 0); // Line 425, amendment 1: firing listeners is work.
      }
      await bounded(c, connection.shutdown(c.clock.now()));
      for (let i = 0; i < 64; i++) await Promise.resolve();
      // Shutdown ends the stream and cancels every call actually started (430).
      c.assert(ended && aborts === calls); await collect;
      const seq = seen.filter(e => "seq" in e).map(e => "seq" in e ? e.seq : 0);
      c.assert(seq.every((n, i) => n === i + 1)); // Line 114: fresh events add one seq.
    }
    // Line 426 applies to a raw then callback as well as a for-await consumer.
    const connection = createProbed(c, { clock: c.clock, store: new Map(), hash_key: new Uint8Array(32), audible: false });
    let depth = 0, called = false;
    void connection.events[Symbol.asyncIterator]().next().then(() => { c.assert(depth === 0); called = true; }, () => { c.failed = true; });
    depth++; try { connection.send(hello); c.assert(!called); } finally { depth--; }
    for (let i = 0; i < 64; i++) await Promise.resolve();
    await c.clock.advance(0);
    for (let i = 0; i < 64; i++) await Promise.resolve();
    c.assert(called); // Hello must provide the first event; the consumer must resume.
    await bounded(c, connection.shutdown(c.clock.now()));
  },
  ...negotiationCases,
  ...pacingCases,
  ...artifactCases,
  "GEN-02": async c => {
    const t = setup(c, [...steps(100), ...steps(100)]);
    for (const request_id of ["request-gen-1", "request-gen-2"]) {
      t.connection.send({ ...read(request_id, request_id, multiText), lookahead: 3 });
      for (let i = 0; i < 24; i++) await t.settle(1);
      complete(t, c, request_id); await t.settle();
      success(c, t.seen, request_id, 3, t.backend.calls);
    }
    await t.finish();
    for (const id of ["request-gen-1", "request-gen-2"]) success(c, t.seen, id, 3, t.backend.calls);
    c.assert(!t.seen.some(e => e.type === "error"));
  },
  "LIFE-01e": async c => {
    const text = multiText.replace("cranes", "𝒸ranes"); // One astral character distinguishes UTF-16 units.
    for (const failed of [false, true]) {
      const script = failed ? [steps()[0], { latency_ms: 3, late_after_cancel: false, result: { kind: "error", code: "invented failure" } } satisfies BackendStep] : steps();
      const t = await multi(c, script, text);
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
        if (piece) c.assert(r?.edge === "audio_ready" && r.session_id === piece.session_id && requested[0].session_id === piece.session_id && requested[0].seq < r.seq && r.t_mono_ms === requested[0].t_mono_ms + script[i].latency_ms && r.duration_ms === piece.duration_ms && r.sample_count === piece.artifact.sample_count && r.first_audible_offset_ms >= 0 && r.first_audible_offset_ms <= piece.duration_ms && requested[0].edge === "synthesis_requested" && requested[0].chars === piece.spoken_text.length && requested[0].segment_index === 0);
      }
      c.assert(records.every((r, i) => i === 0 || r.t_mono_ms >= records[i - 1].t_mono_ms));
      textFree(c, text);
      if (!failed) success(c, t.seen, "request-multi", 3, t.backend.calls);
      else interrupted(c, t.seen, "request-multi", 1, "failed", t.backend.calls);
      const outcome = t.seen.findIndex(e => e.type === "outcome"); c.assert(outcome >= 0 && !t.seen.slice(outcome + 1).some(e => e.type === "lifecycle"));
    }
  },
  "TIME-01": async c => {
    // Keep the half-up tie, and independently separate the formulas without a tie.
    for (const audioShapes of [shapes, [[3, 10000], [6, 20000], [7, 4800]], [[3, 10000], [12, 40000], [7, 4800]]]) {
      const script: BackendStep[] = audioShapes.map(([n, rate], i) => ({ latency_ms: i + 2, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(n, rate, 999), sample_rate: 8000 } }));
      const t = await multi(c, script); complete(t, c); await t.settle(); await t.finish();
      const { pieces } = success(c, t.seen, "request-multi", 3, t.backend.calls);
      c.assert(cumulative(2, 1, audioShapes) !== audioShapes.slice(0, 2).reduce((sum, [n, r]) => sum + Math.round(n * 1000 / r), 0));
      pieces.forEach((p, i) => c.assert(p.start_ms === cumulative(i, 1, audioShapes) && p.artifact.sample_rate === audioShapes[i][1] && p.artifact.sample_count === audioShapes[i][0]));
    }
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
      textFree(c, multiText);
      interrupted(c, t.seen, "request-multi", failedIndex, "failed", t.backend.calls);
    }
  },
  "WORD-02": async c => {
    const script: BackendStep[] = [[750, 2500], [4000, 10000], [2400, 4800]].map(([n, rate], i) => ({ latency_ms: i + 2, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(n, rate, 999) } }));
    const t = await multi(c, script); complete(t, c); await t.settle(); await t.finish();
    const plans = t.seen.filter(e => e.type === "plan"), pieces = t.seen.filter(e => e.type === "piece_ready");
    success(c, t.seen, "request-multi", 3, t.backend.calls);
    c.assert(plans.length === 1 && pieces.length === 3 && pieces.every(p => p.duration_ms >= 300));
    c.assert(JSON.stringify(pieces.flatMap(p => p.words.map(w => w.index))) === JSON.stringify(plans[0].words.map(w => w.index)));
    for (const p of pieces) c.assert(p.words.length > 0 && p.words.every((w, i) => Number.isFinite(w.start_ms) && Number.isFinite(w.end_ms) && w.timing === "estimated" && w.start_ms >= p.start_ms && w.end_ms > w.start_ms && w.end_ms <= p.start_ms + p.duration_ms && (i === 0 || w.start_ms >= p.words[i - 1].end_ms)));
  },
  "DET-01": async c => {
    const t = setup(c, [...steps(12), ...steps(24)]);
    for (const scale of [12, 24]) {
      t.connection.send({ ...read(`request-det-${scale}`, `key-det-${scale}`, multiText), lookahead: 3 });
      for (let i = 0; i < 24; i++) await t.settle(1);
      complete(t, c, `request-det-${scale}`); await t.settle();
      const { pieces, records, durations } = success(c, t.seen, `request-det-${scale}`, 3, t.backend.calls);
      c.assert(pieces.length === 3 && durations.length >= 3 && durations.every(d => shapes.some((_, i) => d.known_ms === cumulative(i + 1, scale))));
      pieces.forEach((p, i) => {
        const duration = Math.round(shapes[i][0] * scale * 1000 / shapes[i][1]);
        c.assert(p.start_ms === cumulative(i, scale) && p.duration_ms === duration && p.artifact.sample_count === shapes[i][0] * scale);
        c.assert(p.words.length === 3 && p.words.every((w, j) => w.start_ms === p.start_ms + Math.round(j * duration / 3) && w.end_ms === p.start_ms + Math.round((j + 1) * duration / 3)));
        c.assert(durations.some(d => d.known_ms === cumulative(i + 1, scale)));
        const ready = records.filter(r => r.edge === "audio_ready" && r.piece_index === i);
        c.assert(ready.length === 1 && ready[0].edge === "audio_ready" && ready[0].duration_ms === duration && ready[0].sample_count === shapes[i][0] * scale && ready[0].duration_ms === p.duration_ms && ready[0].sample_count === p.artifact.sample_count);
      });
    }
    await t.finish();
    for (const scale of [12, 24]) success(c, t.seen, `request-det-${scale}`, 3, t.backend.calls);
    c.assert(!t.seen.some(e => e.type === "error"));
  },
  "PLAN-LAT-01": async c => {
    // Repeat with shutdown at each call, so the second request needs its own plan too.
    for (const target of [1, 2]) {
      const backend = new ScriptedBackend(c.clock), spawn = new ScriptedSpawn(c.clock), player = new ScriptedPlayer(c.clock, spawn);
      backend.script(Array.from({ length: target }, () => audio()));
      const original = backend.synthesizeRequest.bind(backend);
      const connection = createProbed(c, { clock: c.clock, ports: { backend, player, spawn, host: new ScriptedHost(c.clock) }, store: new Map(), hash_key: new Uint8Array(32), audible: false });
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
        interrupted(c, seen, `request-${i + 1}`, 0, "interrupted", backend.calls);
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
    success(c, t.seen, "request-1", 1, t.backend.calls);
    c.assert(!t.seen.some(e => e.type === "error"));
    c.assert(t.seen.at(-1)?.type === "outcome"); // Live-lease timing_update exception is owed to alignment (S7).
  },
  "ERR-01": async c => {
    const t = setup(c, [{ latency_ms: 1, late_after_cancel: false, result: { kind: "error", code: "synthetic failure" } }]);
    t.connection.send(read()); await t.settle(1); await t.finish();
    const errors = t.seen.filter(e => e.type === "error"), outcomes = t.seen.filter(e => e.type === "outcome");
    c.assert(errors.length === 1 && errors[0].code === "SYNTH_FAILED" && errors[0].phase === "synthesize" && errors[0].retry === "new_request");
    const accepted = t.seen.find(e => e.type === "accepted");
    c.assert(accepted?.type === "accepted" && errors[0].session_id === accepted.session_id);
    textFree(c, "Copper boats drift.");
    interrupted(c, t.seen, "request-1", 0, "failed", t.backend.calls);
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
    interrupted(c, t.seen, "request-1", 0, "cancelled", t.backend.calls);
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
    for (const id of ["request-1", "request-2"]) success(c, t.seen.filter(e => e.type !== "error" || e.code !== "IDEMPOTENCY_CONFLICT"), id, 1, t.backend.calls);
    c.assert(t.seen.filter(e => e.type === "error").length === 1);
  },
  "TIME-02": async c => {
    const t = setup(c, [audio()]); t.connection.send(read()); await t.settle(1); await t.finish();
    success(c, t.seen, "request-1", 1, t.backend.calls);
    c.assert(!t.seen.some(e => e.type === "error"));
    const pieces = t.seen.filter(e => e.type === "piece_ready"); c.assert(pieces.length === 1);
    for (const piece of pieces) { c.assert(piece.duration_ms === 100 && piece.start_ms === 0); c.assert(piece.artifact.sample_count === 100 && piece.artifact.sample_rate === 1000); c.assert(piece.words.every(w => w.start_ms >= 0 && w.end_ms <= 100)); }
    for (const event of t.seen) {
      if (event.type === "duration") c.assert(event.known_ms === 100);
      if (event.type === "lifecycle" && event.edge === "audio_ready") c.assert(event.duration_ms === 100);
    }
  },
};

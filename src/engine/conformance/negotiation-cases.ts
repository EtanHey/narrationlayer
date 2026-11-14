import { createProbed, assertBackendCalls } from "./engine-cases";
import { FakeClock } from "./clock";
import type { Case, CaseContext } from "./runner";
import type { Json } from "./binding";
import type { Event, Message } from "../messages/messages";
import { json } from "../messages/schema";
import minor0 from "./minor-0.fixtures.json";
import { parseRequest, parseEvent } from "../messages/parser";
import { ScriptedBackend, pcmAudio } from "./fake-backend";
import { ScriptedPlayer, ScriptedSpawn } from "./fake-player";
import { ScriptedHost } from "./host-stub";
const hello = { protocol: "nl.engine/1", type: "hello", client: { name: "synthetic", version: "1" }, binding: "in-process", stage: "A", required_caps: [] } satisfies Json;
const read = (text = "Copper boats drift.") => ({ protocol: "nl.engine/1", type: "narrate", request_id: "request-neg", idempotency_key: "key-neg", use: "read", input: { text, format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" } satisfies Json);
function setup(c: CaseContext, audio = false, clock = c.clock) {
  const backend = new ScriptedBackend(clock), spawn = new ScriptedSpawn(clock), player = new ScriptedPlayer(clock, spawn);
  if (audio) {
    const synthesize = backend.synthesizeRequest.bind(backend);
    backend.synthesizeRequest = (request, signal) => {
      backend.script([{ latency_ms: 1, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(100, 1000) } }]);
      return synthesize(request, signal);
    };
  }
  const connection = createProbed(c, { clock, ports: { backend, spawn, player, host: new ScriptedHost(clock) }, store: new Map(), hash_key: new Uint8Array(32).fill(1), audible: false });
  const seen: Event[] = [];
  let ended = false;
  const collecting = (async () => { for await (const raw of connection.events) { if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.type === "welcome") c.assert(!("seq" in raw)); const parsed = parseEvent(raw); c.assert(parsed.ok && parsed.value !== null); if (parsed.ok && parsed.value) seen.push(parsed.value); } ended = true; })().catch(() => { c.failed = true; });
  const settle = async () => { for (let i = 0; i < 8; i++) { await clock.advance(1); for (let j = 0; j < 128; j++) await Promise.resolve(); } };
  return { connection, seen, backend, clock, settle, ended: () => ended,
    async finish() { let done = false; void connection.shutdown(clock.now()).then(() => { done = true; }); await settle(); c.assert(done && ended); await collecting; backend.assertDrained(); spawn.assertDrained(); player.assertDrained(); },
  };
}
function refusal(c: CaseContext, seen: Event[], code: Message<"error">["code"], retry: Message<"error">["retry"]) {
  c.assert(seen.length === 1 && seen[0].type === "error");
  const error = seen[0];
  c.assert(error.type === "error" && error.code === code && error.phase === "negotiate" && error.retry === retry && error.seq === 1);
}
function textFree(c: CaseContext, text: string) {
  const raw = JSON.stringify(c.trace.filter(e => e && typeof e === "object" && !Array.isArray(e) && e.type === "error"));
  for (let i = 0; i <= text.length - 8; i++) c.assert(!raw.includes(text.slice(i, i + 8)));
}
// Local counterpart of engine-cases.success until the shared receipt is exported.
function receipt(c: CaseContext, t: ReturnType<typeof setup>, text: string) {
  const accepted = t.seen.filter(e => e.type === "accepted"); c.assert(accepted.length === 1 && accepted[0].request_id === "request-neg");
  const own = t.seen.filter(e => "session_id" in e && e.session_id === accepted[0].session_id);
  const plans = own.filter(e => e.type === "plan"), pieces = own.filter(e => e.type === "piece_ready"), records = own.filter(e => e.type === "lifecycle"), durations = own.filter(e => e.type === "duration");
  c.assert(plans.length === 1 && plans[0].pieces.length > 0 && pieces.length === plans[0].pieces.length);
  const plan = plans[0];
  c.assert(plan.display_document.text === text && plan.words.map(w => w.text).join(" ") === text.trim().split(/\s+/u).join(" "));
  c.assert(pieces.every((p, i) => p.index === i && p.piece_id === plan.pieces[i].piece_id && p.attempt_id === plan.attempt_id && own.indexOf(plan) < own.indexOf(p)));
  c.assert(records.length === 2 * pieces.length && pieces.every(p => records.filter(r => r.piece_index === p.index && r.edge === "synthesis_requested").length === 1 && records.filter(r => r.piece_index === p.index && r.edge === "audio_ready").length === 1));
  const finals = durations.filter(d => d.final); c.assert(finals.length === 1 && pieces.every(p => own.indexOf(p) < own.indexOf(finals[0])));
  c.assert(durations.every((d, i) => own.indexOf(d) > own.indexOf(pieces[0]) && (i === 0 || d.known_ms >= durations[i - 1].known_ms) && (d.final || own.indexOf(d) < own.indexOf(finals[0]))));
  assertBackendCalls(c, t.seen, t.backend.calls, accepted[0].session_id, pieces).forEach((call, i) => c.assert(call !== null && typeof call === "object" && !Array.isArray(call) && call.text === plan.words.slice(plan.pieces[i].word_start, plan.pieces[i].word_end).map(w => w.text).join(" ")));
  const outcomes = own.filter(e => e.type === "outcome"); c.assert(outcomes.length === 1 && outcomes[0].generation.status === "committed" && own.at(-1)?.type === "outcome"); // Live-lease timing_update exception is owed to alignment (S7).
  c.assert(!t.seen.some(e => e.type === "error"));
}
async function completed(c: CaseContext, t: ReturnType<typeof setup>, text = "Copper boats drift.", count = 1) {
  await t.settle();
  const a = t.seen.filter(e => e.type === "accepted"); c.assert(a.length === 1 && a[0].request_id === "request-neg");
  const pieces = t.seen.filter(e => e.type === "piece_ready").filter(e => e.session_id === a[0].session_id); c.assert(pieces.length === count);
  for (const p of pieces) for (const edge of ["spawned", "first_sample", "last_sample", "exited"]) t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: a[0].session_id, player_instance_id: `synthetic-player-${p.index}`, control_epoch: p.index + 1, piece_index: p.index, edge, t_mono_ms: t.clock.now(), ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: p.start_ms + p.duration_ms } } : {}) });
  await t.finish(); receipt(c, t, text);
  c.assert(t.seen.some(e => e.type === "outcome" && e.session_id === a[0].session_id && e.playback.reason === "completed"));
}
export const negotiationCases: Record<string, Case> = {
  "VER-01": async c => {
    // Recorded minor-0 wire values are independent expectations, not parser output.
    const canonical = (v: unknown) => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);
    for (const fixture of minor0) { const parsed = parseRequest(fixture.wire); c.assert(parsed.ok && canonical(parsed.value) === canonical(fixture.expected)); }
    const t = setup(c, true); t.connection.send(json.read(minor0[0].wire, "$")); await t.settle();
    const w = t.seen[0]; c.assert(t.seen.length === 1 && w.type === "welcome" && w.protocol_minor >= 0 && w.caps.includes("lifecycle"));
    t.connection.send(read()); await completed(c, t);
  },
  "LIM-01": async c => {
    for (const use of ["read", "speak", "ask_prompt"] as const) {
      const probe = setup(c); probe.connection.send(hello); await probe.settle();
      const w = probe.seen[0]; c.assert(w?.type === "welcome"); if (w?.type !== "welcome") return;
      const limit = w.limits.max_chars[use]; c.assert(Number.isInteger(limit) && limit > 0); await probe.finish();
      // The limit counts raw UTF-16 units, before trimming or Unicode normalization (lead ruling 43).
      for (const [ending, excess] of [["x", false], ["x", true], ["😀", false], ["😀", true], ["x ", true], ["ﬁ", false], ["ｶﾞ", true], ["e\u0301", true], ["\u00e9", false]] as const) {
        const t = setup(c, !excess); t.connection.send(hello);
        const text = "x".repeat(limit + Number(excess) - ending.length) + ending;
        t.connection.send({ ...read(text), use, mode: "brief", retain_artifact: true }); await t.settle();
        if (excess) {
          const errors = t.seen.filter(e => e.type === "error");
          c.assert(errors.length === 1 && errors[0].code === "INPUT_TOO_LONG" && errors[0].phase === "admit" && errors[0].retry === "never" && errors[0].request_id === "request-neg");
          c.assert(t.seen.length === 2 && !t.seen.some(e => e.type === "accepted")); await t.finish(); textFree(c, text);
        } else {
          await completed(c, t, text);
          const plan = t.seen.find(e => e.type === "plan"), piece = t.seen.find(e => e.type === "piece_ready");
          c.assert(plan?.type === "plan" && plan.display_document.text === text && piece?.type === "piece_ready" && piece.spoken_text === text);
        }
      }
    }
    for (const invalid of [false, true]) {
      const t = setup(c, !invalid); t.connection.send(hello); await t.settle();
      const w = t.seen[0]; c.assert(w?.type === "welcome"); if (w?.type !== "welcome") return;
      t.connection.send({ ...read(), lookahead: invalid ? 0 : w.limits.lookahead + 1 });
      if (!invalid) await completed(c, t);
      else { await t.settle(); const e = t.seen[1]; c.assert(t.seen.length === 2 && e.type === "error" && e.code === "INVALID_REQUEST" && e.phase === "admit" && e.retry === "never" && e.request_id === "request-neg"); await t.finish(); }
    }
  },
  "VER-02e": async c => {
    const t = setup(c); t.connection.send(hello); t.connection.send({ protocol: "nl.engine/1", type: "synthetic-unknown" }); await t.settle();
    const e = t.seen[1]; c.assert(t.seen.length === 2 && e.type === "error" && e.code === "INVALID_REQUEST" && e.phase === "admit" && e.retry === "never"); await t.finish();
    const traces: Json[][] = [];
    const extensions: Record<string, Json>[] = [{}, { future: { arbitrary: ["synthetic", 1] } }];
    for (const extras of extensions) {
      const start = c.trace.length, t = setup(c, true, new FakeClock()), request = read();
      const misplaced: Record<string, Json> = extras.future ? { session_id: "synthetic-ignored", text: "synthetic-ignored" } : {};
      t.connection.send({ ...hello, ...extras, client: { ...hello.client, ...extras } });
      t.connection.send({ ...request, ...extras, ...misplaced, input: { ...request.input, ...extras }, voice: { ...request.voice, ...extras } }); await t.settle();
      const accepted = t.seen.find(e => e.type === "accepted"); c.assert(accepted?.type === "accepted"); if (accepted?.type !== "accepted") return;
      t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: accepted.session_id, player_instance_id: "synthetic-player", control_epoch: 1, piece_index: 0, edge: "spawned", t_mono_ms: 50, exit: { status: "completed", stopped_at_ms: 100, ...extras }, ...extras });
      t.connection.send({ protocol: "nl.engine/1", type: "control", command_id: "synthetic-stop", session_id: accepted.session_id, op: "stop", args: { scope: "session", reason: "stop", ...extras }, ...extras });
      await t.finish();
      c.assert(t.seen.filter(e => e.type === "plan").length === 1 && t.seen.filter(e => e.type === "piece_ready").length === 1 && t.seen.some(e => e.type === "control_ack" && e.command_id === "synthetic-stop") && t.seen.filter(e => e.type === "outcome").length === 1 && !t.seen.some(e => e.type === "error"));
      receipt(c, t, request.input.text);
      traces.push(c.trace.slice(start));
    }
    c.assert(JSON.stringify(traces[0]) === JSON.stringify(traces[1]));
    const streams: Event[][] = [], text = "# Copper boats.\n\nAmber rafts float.";
    for (const extension of ["none", "top-level", "input-sibling", "voice"]) {
      const t = setup(c, true, new FakeClock()), request = read(text);
      t.connection.send(hello);
      t.connection.send({ ...request, ...(extension === "top-level" ? { format: "markdown" } : {}), input: { ...request.input, ...(extension === "input-sibling" ? { format2: "markdown" } : {}) }, voice: { ...request.voice, ...(extension === "voice" ? { format: "markdown" } : {}) } });
      await completed(c, t, text, 2); streams.push(t.seen);
    }
    for (const stream of streams.slice(1)) c.assert(JSON.stringify(stream) === JSON.stringify(streams[0]));
  },
  "NEG-01": async c => {
    for (const major of ["0", "2", "3", "10", "01", "001"]) {
      const t = setup(c); t.connection.send({ ...hello, protocol: `nl.engine/${major}` }); await t.settle();
      refusal(c, t.seen, "UNSUPPORTED_VERSION", "never"); c.assert(t.ended());
      t.connection.send(read()); t.connection.send(hello); await t.settle();
      refusal(c, t.seen, "UNSUPPORTED_VERSION", "never"); await t.finish(); textFree(c, "Copper boats drift.");
    }
  },
  "NEG-02": async c => {
    const probe = setup(c); probe.connection.send(hello); await probe.settle();
    const welcome = probe.seen[0]; c.assert(probe.seen.length === 1 && welcome?.type === "welcome");
    if (welcome?.type !== "welcome") return;
    c.assert(welcome.caps.length > 0 && welcome.caps.includes("lifecycle")); await probe.finish();
    const known = ["read", "speak", "ask_prompt", "display_document", "word_timing", "alignment", "seek", "speed", "artifacts", "amplitude", "lifecycle", "seed", "player", "speaker_permits", "read_queue", "previous_read", "replay"];
    const absent = known.filter(cap => !welcome.caps.includes(cap)); c.assert(absent.length > 0);
    for (const required_caps of [absent, [welcome.caps[0], absent[0]], ["Synthetic hidden capability words"], ...welcome.caps.map(cap => [cap])]) {
      const t = setup(c); t.connection.send({ ...hello, required_caps }); await t.settle();
      if (required_caps.every(cap => welcome.caps.includes(cap))) c.assert(t.seen.length === 1 && t.seen[0].type === "welcome");
      else {
        refusal(c, t.seen, "MISSING_CAPABILITY", "never"); c.assert(t.ended());
        const error = t.seen[0]; c.assert(error.type === "error" && JSON.stringify(error.details) === JSON.stringify({ missing_caps: required_caps.filter(cap => known.includes(cap) && !welcome.caps.includes(cap)), unknown_cap_indices: required_caps[0] === "Synthetic hidden capability words" ? [0] : [] }));
        t.connection.send(hello); await t.settle(); c.assert(t.seen.length === 1);
      }
      await t.finish();
    }
    for (const message of [{ ...hello, stage: "B" }, { ...hello, stage: "B", required_caps: [welcome.caps[0], absent.find(cap => cap !== "player")!] }, { ...hello, optional_caps: absent, last_owner_epoch: 999 }]) {
      const t = setup(c); t.connection.send(message); await t.settle();
      if (message.stage === "B" && !welcome.caps.includes("player")) {
        refusal(c, t.seen, "MISSING_CAPABILITY", "never"); c.assert(t.ended());
        const e = t.seen[0]; c.assert(e.type === "error" && JSON.stringify(e.details) === JSON.stringify({ missing_caps: ["player", ...message.required_caps.filter(cap => !welcome.caps.includes(cap))], unknown_cap_indices: [] }));
        t.connection.send(hello); await t.settle(); c.assert(t.seen.length === 1);
      } else c.assert(t.seen.length === 1 && t.seen[0].type === "welcome" && !t.ended());
      await t.finish();
    }
    for (const message of [{ optional_caps: absent }, { optional_caps: [welcome.caps[0]] }, { required_caps: [welcome.caps[0]], optional_caps: absent }]) {
      const t = setup(c); t.connection.send({ ...hello, ...message }); await t.settle();
      const w = t.seen[0]; c.assert(t.seen.length === 1 && w.type === "welcome" && JSON.stringify(w.caps) === JSON.stringify(welcome.caps) && !t.ended());
      await t.finish();
    }
    textFree(c, "Synthetic hidden capability words");
  },
  "NEG-03": async c => {
    const t = setup(c, true);
    const before: Json[] = [read(), { protocol: "nl.engine/1", type: "control", command_id: "synthetic", session_id: "synthetic", op: "stop", args: { scope: "session", reason: "stop" } }, { protocol: "nl.engine/1", type: "player_feedback", session_id: "synthetic", player_instance_id: "synthetic", control_epoch: 1, piece_index: 0, edge: "spawned", t_mono_ms: 0 }, null, {}, "hello", [hello], 7, { type: 5 }, { ...read(), protocol: "nl.engine/2" }];
    for (const message of before) t.connection.send(message);
    await t.settle(); c.assert(t.seen.length === before.length);
    t.seen.forEach((e, i) => c.assert(e.type === "error" && e.code === "NOT_NEGOTIATED" && e.phase === "negotiate" && e.retry === "after_resync" && e.seq === i + 1));
    c.assert(t.seen[0].type === "error" && t.seen[0].request_id === "request-neg" && !t.ended());
    t.connection.send({ protocol: "nl.engine/1", type: "hello" }); await t.settle();
    const malformed = t.seen.at(-1); c.assert(t.seen.length === before.length + 1 && malformed?.type === "error" && malformed.code === "INVALID_REQUEST" && malformed.phase === "admit" && malformed.retry === "never" && !t.ended());
    t.connection.send(hello); await t.settle(); c.assert(t.seen.length === before.length + 2 && t.seen.at(-1)?.type === "welcome");
    // Keep the refusal evidence, but scope successful-read assertions to the read.
    t.seen.splice(0, before.length + 1);
    t.connection.send(hello); await t.settle();
    const repeated = t.seen.at(-1); c.assert(t.seen.length === 2 && repeated?.type === "error" && repeated.code === "INVALID_REQUEST" && repeated.phase === "admit" && repeated.retry === "never" && !t.ended());
    t.seen.pop(); t.connection.send(read()); await completed(c, t);
    let seq = 0; for (const raw of c.trace) if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.type !== "welcome") c.assert(raw.seq === ++seq);
    textFree(c, "Copper boats drift.");
    // Malformed hello protocols fail parsing; the same binding can still negotiate.
    for (const protocol of ["nl.engine/1x", "nl.engine/1.0", "nl.engine/one", "nl.engine/1 ", " nl.engine/1", ""]) {
      const start = c.trace.length, t = setup(c); t.connection.send({ ...hello, protocol }); await t.settle();
      const e = t.seen[0]; c.assert(t.seen.length === 1 && e.type === "error" && e.code === "INVALID_REQUEST" && e.phase === "admit" && e.retry === "never" && !t.ended());
      c.assert(!c.trace.slice(start).some(raw => raw !== null && typeof raw === "object" && !Array.isArray(raw) && raw.type === "welcome"));
      t.connection.send(hello); await t.settle(); c.assert(t.seen.length === 2 && t.seen[1].type === "welcome" && !t.ended());
      await t.finish();
    }
  },
};

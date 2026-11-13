import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createEngineSession, type Publication, type ReadPlanner } from "../../../src/engine/session/session";
import { initialState, reduce, type Input } from "../../../src/engine/reducer/session";
import { parseEvent } from "../../../src/engine/messages/parser";
import type { Event, Message } from "../../../src/engine/messages/messages";
import { planSynthesisUnits, type SynthesisSourceUnit } from "../../../src/plan/synthesis-units";
import { FakeClock } from "../../../src/engine/conformance/clock";
import { ScriptedBackend, pcmAudio } from "../../../src/engine/conformance/fake-backend";
const request: Message<"narrate"> = { protocol: "nl.engine/1", type: "narrate", request_id: "req-one", idempotency_key: "key-one", use: "read", input: { text: "Synthetic text only.", format: "plain" }, voice: { profile: "fake", require_clone: false, fallback: "none" }, delivery: "pieces" };
const limits = { max_chars: { read: 1000, speak: 100, ask_prompt: 100 }, lookahead: 2, aligner_reap_ms: 100 };
const units: SynthesisSourceUnit[] = [{ kind: "heading", text: "Synthetic heading", pause_after_ms: 0 }, { kind: "list_item", text: "Synthetic whole list item.", pause_after_ms: 0 }];
const active: { session: { shutdown(d: number): Promise<void>; events: AsyncIterable<Event> }; events(): Event[]; epoch: number; inputs: Input<"host">[]; delivered: { event: Event; replay: boolean }[] }[] = [];
function harness(epoch = 1, source = units) {
  const clock = new FakeClock(), backend = new ScriptedBackend(clock), delivered: { event: Event; replay: boolean }[] = [], inputs: Input<"host">[] = [];
  let calls = 0, callsBeforePlan = 0, publications = 0;
  // Synthetic stand-in only: typed units plus real cutter, whitespace word table.
  // This proves neither projection nor WORD-01; real projection belongs to S3p.
  const planner: ReadPlanner = { plan(req, _limits, identity) {
    calls++;
    const pieces = planSynthesisUnits({ units: source, max_chars: 1000 });
    const text = source.map(u => u.text).join(" ");
    let offset = 0;
    const words = text.split(" ").map((text, index) => {
      const display: [number, number] = [offset, offset + text.length];
      offset += text.length + 1;
      return { index, text, display };
    });
    return { plan: { type: "plan", ...identity, display_document: { version: 1, text, speech_start: 0, blocks: [] }, words, pieces: pieces.map((p, index) => ({ piece_id: `piece-${identity.session_id}-${index}`, index, word_start: 0, word_end: words.length, raw: false, segments: p.segments.map(s => ({ word_start: 0, word_end: words.length, kind: s.kind === "list_item" ? "item" : s.kind, pause_after_ms: s.pause_after_ms, pause_in: s.pause_in })) })), engine: { family: "fake", profile_revision: "1", voice: req.voice.profile } }, requests: pieces.map((p, index) => ({ piece_index: index, text: p.segments[0].text })) };
  } };
  const publication: Publication<ReturnType<typeof pcmAudio>> = {
    async piece(audio, context) { publications++; return { type: "piece_ready", ...context, duration_ms: audio.samples, artifact: { handle: "synthetic", lease_id: "synthetic", format: "wav", sample_rate: audio.sample_rate, sample_count: audio.samples, sha256: "synthetic" }, words: [], actual: [], synthesis: { rate: "+0%", attempts: [], unavailable: [], fallback_reason: null } }; }, async commit() {},
  };
  const observe = { input(i: Input<"host">) { inputs.push(i); }, event(event: Event, replay: boolean) { delivered.push({ event, replay }); } };
  const session = createEngineSession({ owner_epoch: epoch, limits, planner, clock, publication,
    backend: { synthesizeRequest(r, signal) { if (!delivered.some(d => d.event.type === "plan")) callsBeforePlan++; return backend.synthesizeRequest(r, signal); } },
    observe,
  });
  const h = { session, clock, backend, publication, planner, delivered, inputs, epoch, observe, get publicationCalls() { return publications; }, get plannerCalls() { return calls; }, get callsBeforePlan() { return callsBeforePlan; }, events: () => delivered.map(d => d.event),
    script(n = source.length, late = false) { backend.script(Array.from({ length: n }, () => ({ latency_ms: 1, late_after_cancel: late, result: { kind: "audio", ...pcmAudio(10) } }))); },
    async tick() { for (let i = 0; i < 12; i++) await clock.advance(1); },
    stop(reason: "stop" | "cancel" = "stop") { session.send({ protocol: "nl.engine/1", type: "control", command_id: "stop-one", session_id: `session-${epoch}-1`, op: "stop", args: { scope: "session", reason } }); },
    feedback(edge: Message<"player_feedback">["edge"], piece_index = 0) { session.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: `session-${epoch}-1`, player_instance_id: "host-player", control_epoch: 1, piece_index, edge, t_mono_ms: clock.monotonic(), ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: 10 } } : {}) }); },
  }; active.push(h); return h;
}
afterEach(async () => {
  for (const h of active.splice(0)) {
    await h.session.shutdown(100);
    const wire: Event[] = [];
    for await (const event of h.session.events) wire.push(event);
    let state = initialState(h.epoch, "host");
    const folded: { event: Event; replay: boolean }[] = [];
    for (const input of h.inputs) {
      const result = reduce(state, input); state = result.state;
      for (const e of result.effects) if (e.kind === "emit" || e.kind === "replay") folded.push({ event: e.event, replay: e.kind === "replay" });
    }
    expect(JSON.stringify(wire)).toBe(JSON.stringify(folded.map(e => e.event)));
    for (const e of wire) expect(parseEvent(e)).toEqual({ ok: true, value: e });
    const fresh = wire.filter((_, i) => !folded[i].replay);
    expect(fresh.map(e => "seq" in e && e.seq)).toEqual(fresh.map((_, i) => i + 1));
  }
});
test("PLAN-LAT-01: plan is enqueued before the first backend call", () => {
  const h = harness(); h.script(); h.session.send(request);
  expect(h.callsBeforePlan).toBe(0); expect(h.events().map(e => e.type)).toEqual(["accepted", "plan"]);
});
test("planner called once: repeated admission never replans or starts work", () => {
  const h = harness(); h.script(); h.session.send(request); h.session.send(request);
  expect(h.plannerCalls).toBe(1); expect(h.backend.calls).toHaveLength(1);
  expect(h.delivered.at(-1)).toEqual({ event: h.events()[0], replay: true });
});
test("SESS-01: unknown session gets UNKNOWN_SESSION; terminal replay remains", async () => {
  const h = harness(); h.stop(); expect(h.events()).toMatchObject([{ type: "error", code: "UNKNOWN_SESSION" }]);
  h.script(); h.session.send(request); h.stop(); h.session.send(request); await h.tick();
  expect(h.events().filter(e => e.type === "outcome")).toHaveLength(1);
  expect(h.delivered.at(-1)?.replay).toBe(true);
});
test("ORDER-01 (lease clause owed to S7): ordered prefix and no events after outcome", async () => {
  const h = harness(); h.script(); h.session.send(request); await h.tick();
  expect(h.events().filter(e => e.type === "piece_ready").map(e => e.index)).toEqual([0, 1]);
  h.feedback("spawned", 1); h.feedback("first_sample", 1); h.feedback("exited", 1);
  expect(h.events().at(-1)).toMatchObject({ type: "outcome", generation: { status: "committed" }, playback: { reason: "completed" } });
  const count = h.events().length; h.feedback("exited", 1); await h.tick(); expect(h.events()).toHaveLength(count);
});
test("GEN-02: sequential calls and complete delivery before commit", async () => {
  const h = harness(); h.script(); h.session.send(request); expect(h.backend.calls).toHaveLength(1);
  await h.tick(); expect(h.backend.calls.map(r => r && typeof r === "object" && !Array.isArray(r) ? r.piece_index : null)).toEqual([0, 1]);
  const committed = h.inputs.find(i => i.kind === "backend" && i.result.kind === "commit"); expect(committed).toBeDefined();
  expect(h.events().filter(e => e.type === "piece_ready").map(e => e.start_ms)).toEqual([0, 10]); // duration.final is S4.
});
test("ERR-01: backend failure emits synthesize/new_request then exactly one outcome", async () => {
  const h = harness(); h.backend.script([{ latency_ms: 1, late_after_cancel: false, result: { kind: "error", code: "private backend detail" } }]);
  h.session.send(request); await h.tick();
  expect(h.events().slice(-2)).toMatchObject([{ type: "error", code: "SYNTH_FAILED", phase: "synthesize", retry: "new_request" }, { type: "outcome", playback: { reason: "synth_failed" } }]);
  expect(JSON.stringify(h.events())).not.toContain("private backend detail");
});
test("GEN-01e: mid-read failure never completes generation", async () => {
  const h = harness(); h.script(1); h.backend.script([{ latency_ms: 1, late_after_cancel: false, result: { kind: "error", code: "failed" } }]);
  h.session.send(request); await h.tick(); expect(h.events().at(-1)).toMatchObject({ type: "outcome", playback: { reason: "speech_failed" }, generation: { status: "failed" } });
});
test("GEN-03e: natural EOF before final publication failure preserves completed", async () => {
  const h = harness(1, units.slice(0, 1)); h.script();
  let fail!: (e: Error) => void; h.publication.commit = () => new Promise((_, reject) => { fail = reject; });
  h.session.send(request); await h.tick(); h.feedback("spawned"); h.feedback("first_sample"); h.feedback("exited");
  fail(new Error("publication")); await h.tick();
  expect(h.events().at(-1)).toMatchObject({ type: "outcome", playback: { reason: "completed" }, generation: { status: "failed" } });
});
test("ID-02: owner epochs cannot reuse session or attempt identity", async () => {
  const a = harness(1, units.slice(0, 1)), b = harness(2, units.slice(0, 1)); a.script(1, true); b.script(); a.session.send(request); b.session.send(request);
  expect(a.events()[0]).toMatchObject({ owner_epoch: 1, session_id: "session-1-1", attempt_id: "attempt-1-1" });
  expect(b.events()[0]).toMatchObject({ owner_epoch: 2, session_id: "session-2-1", attempt_id: "attempt-2-1" });
  a.stop(); const count = b.events().length; await a.tick();
  expect(a.events().filter(e => e.type === "piece_ready")).toHaveLength(0); expect(b.events()).toHaveLength(count);
  await b.tick(); expect(b.events().filter(e => e.type === "piece_ready")).toHaveLength(1);
  // Foreign async results are identity-bound by closure; wire feedback has no owner field.
});
test("ID-03: stop fences last synthesis before its late result", async () => {
  const h = harness(1, units.slice(0, 1)); h.script(1, true); h.session.send(request); h.stop(); await h.tick();
  expect(h.events().filter(e => e.type === "piece_ready")).toHaveLength(0);
  expect(h.events().filter(e => e.type === "outcome")).toHaveLength(1);
  h.backend.assertDrained();
});
test("late result after stop: fenced audio produces no event or publication", async () => {
  const h = harness(1, units.slice(0, 1)); h.script(1, true); h.session.send(request); h.stop("cancel"); await h.tick();
  expect(h.publicationCalls).toBe(0);
  expect(h.events().filter(e => e.type === "piece_ready")).toHaveLength(0); h.backend.assertDrained();
});
test("ID-04: same text distinct invocations; same key replay; changed request conflict", () => {
  const h = harness(); h.script(4); h.session.send(request); h.session.send(request);
  h.session.send({ ...request, request_id: "req-two", idempotency_key: "key-two" });
  h.session.send({ ...request, input: { text: "Different synthetic text", format: "plain" } });
  expect(h.plannerCalls).toBe(2); expect(h.events().at(-1)).toMatchObject({ type: "error", code: "IDEMPOTENCY_CONFLICT" });
  expect(h.events().filter(e => e.type === "accepted").map(e => e.session_id)).toEqual(["session-1-1", "session-1-1", "session-1-2"]);
});
test("single source of state: reducer input fold reproduces fresh events and replay", async () => {
  const h = harness(); h.script(); h.session.send(request); h.session.send(request); h.session.send({ nope: true }); await h.tick(); h.stop();
  // The shared afterEach now checks this scenario and every other wire through shutdown.
});
test("send never awaits: unresolved synthesis returns accepted synchronously", () => {
  const h = harness(); h.script(1, true); expect(h.session.send(request)).toBeUndefined();
  expect(h.events()[0]?.type).toBe("accepted"); expect(h.backend.calls).toHaveLength(1);
});
test("every event parses: rejection and planner refusal remain text-free and sequenced", () => {
  const h = harness(); h.session.send({ nope: true }); h.session.send({ ...request, input: { text: "x".repeat(1001), format: "plain" } });
  h.planner.plan = () => { throw new Error("private planner text"); };
  h.session.send(request); expect(h.backend.calls).toHaveLength(0);
  expect(h.events().map(e => e.type === "error" && e.code)).toEqual(["INVALID_REQUEST", "INPUT_TOO_LONG", "INVALID_REQUEST"]);
  expect(h.events().at(-1)).toMatchObject({ request_id: request.request_id });
});
test("imports: session has no harness, surface, pipeline or dynamic imports", () => {
  const text = readFileSync("src/engine/session/session.ts", "utf8");
  const forbidden = /(?:from\s*["'][^"']*(?:conformance|pipelines|\/api(?:\/|["'])|bin\/)|import\s*\()/;
  expect(text).not.toMatch(forbidden);
  expect('import { hidden } from "../../api"').toMatch(forbidden);
});

test("parsed admission: unknown wire fields never affect replay or the stored request", () => {
  const h = harness(); h.script(); h.session.send({ ...request, extra: "ignored", input: { ...request.input, extra: "ignored" } }); h.session.send(request);
  expect(h.plannerCalls).toBe(1); expect(h.delivered.at(-1)?.replay).toBe(true);
  for (const i of h.inputs) if (i.kind === "admit" || i.kind === "accept") expect(i.request).toEqual(request);
});
test("parser refusal: unsupported major preserves the contract error code", () => {
  const h = harness(); h.session.send({ ...request, protocol: "nl.engine/2" });
  expect(h.events()).toMatchObject([{ type: "error", code: "UNSUPPORTED_VERSION", phase: "negotiate", retry: "never" }]);
  expect(h.plannerCalls).toBe(0); expect(h.backend.calls).toHaveLength(0);
});

test("invalid refusal: an unknown internal code is a programming rejection, never a wire event", () => {
  const before = initialState(1, "host");
  // @ts-expect-error deliberately exercise an invalid internal call at runtime.
  const result = reduce(before, { kind: "refuse", code: "UNKNOWN_CODE", message: "programming error" });
  expect(result.state).toEqual(before);
  expect(result.effects).toEqual([{ kind: "reject", reason: "INVALID_REFUSAL" }]);
});

test("M1: rejected publication receipt fails once instead of resynthesizing", async () => {
  const h = harness(); h.script(2);
  const publish = h.publication.piece;
  h.publication.piece = async (...args) => ({ ...await publish(...args), piece_id: "mismatched" });
  h.session.send(request); await h.tick();
  expect(h.backend.calls).toHaveLength(1);
  expect(h.events().slice(-2)).toMatchObject([{ type: "error", code: "SYNTH_FAILED" }, { type: "outcome" }]);
});
for (const [name, corrupt] of [
  ["session identity", p => { p.plan.session_id = "wrong-session"; }],
  ["attempt identity", p => { p.plan.attempt_id = "wrong-attempt"; }],
  ["wire schema", p => { Reflect.set(p.plan.engine, "family", 3); }],
  ["request count", p => { p.requests = []; }],
  ["request order", p => { p.requests = [...p.requests].reverse(); }],
] satisfies [string, (p: ReturnType<ReadPlanner["plan"]>) => void][]) test(`M2: invalid planner ${name} refuses before admission`, () => {
  const h = harness(), plan = h.planner.plan;
  h.planner.plan = (...args) => { const result = plan(...args); corrupt(result); return result; };
  h.session.send(request);
  expect(h.events()).toMatchObject([{ type: "error", code: "INVALID_REQUEST", request_id: request.request_id }]);
  expect(h.events()).toHaveLength(1); expect(h.backend.calls).toHaveLength(0);
});
test("N1: parser refusal preserves a raw string request_id", () => {
  const h = harness(); h.session.send({ ...request, voice: 7 });
  expect(h.events()).toMatchObject([{ type: "error", code: "INVALID_REQUEST", request_id: request.request_id }]);
});
test("N4: accept observer failure propagates instead of becoming a planner refusal", () => {
  const h = harness(), record = h.observe.input;
  h.observe.input = i => { if (i.kind === "accept") throw new Error("observer failed"); record(i); };
  expect(() => h.session.send(request)).toThrow("observer failed");
  expect(h.events()).toEqual([]);
});

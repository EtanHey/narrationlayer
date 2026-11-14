import type { Case, CaseContext } from "./runner";
import type { Json } from "./binding";
import { setup, until } from "./engine-cases";
import { pcmAudio } from "./fake-backend";
type Rig = ReturnType<typeof setup>;
function narrate(t: Rig, id: string, after?: string) {
  t.connection.send({ protocol: "nl.engine/1", type: "narrate", request_id: id, idempotency_key: id, use: "read", input: { text: "Copper lanterns shimmer.", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", ...(after ? { start: { after_session: after } } : {}) });
}
async function admitted(c: CaseContext, t: Rig, request: string) {
  await until(c, () => t.seen.some(e => e.type === "accepted" && e.request_id === request));
  const e = t.seen.find(e => e.type === "accepted" && e.request_id === request);
  if (!e || e.type !== "accepted") throw Error("admission unavailable");
  return e.session_id;
}
function feedback(c: CaseContext, t: Rig, id: string, edge: string, epoch = 1) {
  t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: id, control_epoch: epoch, player_instance_id: `player-${id}`, piece_index: 0, edge, t_mono_ms: c.clock.now(), source: "player_reported", ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: 100 } } : {}) });
}
async function control(c: CaseContext, t: Rig, id: string, op: string, args: Json) {
  const command_id = `command-${t.seen.length}`;
  t.connection.send({ protocol: "nl.engine/1", type: "control", session_id: id, command_id, op, args });
  await until(c, () => t.seen.some(e => e.type === "control_ack" && e.command_id === command_id));
  const ack = t.seen.find(e => e.type === "control_ack" && e.command_id === command_id);
  if (!ack || ack.type !== "control_ack") throw Error("ack unavailable");
  return ack;
}
async function fixture(c: CaseContext) {
  const t = setup(c, Array.from({ length: 3 }, () => ({ latency_ms: 2, late_after_cancel: false, result: { kind: "audio" as const, ...pcmAudio(100) } })));
  narrate(t, "playing"); const playing = await admitted(c, t, "playing");
  await until(c, () => t.seen.some(e => e.type === "piece_ready" && e.session_id === playing));
  feedback(c, t, playing, "spawned"); feedback(c, t, playing, "first_sample");
  narrate(t, "queued", playing); const queued = await admitted(c, t, "queued");
  narrate(t, "held"); const held = await admitted(c, t, "held");
  await until(c, () => t.seen.some(e => e.type === "piece_ready" && e.session_id === held));
  return { ...t, playing, queued, held };
}
export const stopCases: Record<string, Case> = {
  "STOP-01e": async c => {
    for (const scope of ["all_speech", "queue", "session"]) {
      const t = await fixture(c), addressed = scope === "queue" ? t.held : t.queued;
      const spared = scope === "session" ? addressed : t.held;
      const ack = await control(c, t, addressed, "stop", { scope, reason: scope === "queue" ? "cancel" : "stop", except_sessions: scope === "queue" ? [] : [spared], retain_read_queue: true });
      const expected = scope === "all_speech" ? [t.playing, t.queued] : scope === "queue" ? [t.queued, t.held] : [];
      await until(c, () => expected.every(id => t.seen.some(e => e.type === "outcome" && e.session_id === id)));
      c.assert(ack.outcome === (expected.length ? "accept" : "noop")); // R80: noop iff no session ended.
      if (scope === "all_speech") {
        const heldAck = await control(c, t, t.held, "stop", { scope, reason: "cancel", except_sessions: [t.held] });
        c.assert(heldAck.outcome === "noop"); // R78/R80: addressed held session is spared too.
      }
      const alive = scope === "queue" ? t.playing : scope === "all_speech" ? t.held : t.playing;
      feedback(c, t, alive, "spawned", 2); feedback(c, t, alive, "first_sample", 2);
      const paused = await control(c, t, alive, "pause", { owner: "user" });
      c.assert(paused.outcome === "accept" && paused.control_epoch >= 2); // R78: spared read still takes feedback and pause.
      // Drain shutdown before checking cardinality; no fixed delivery tick assumption.
      await t.finish();
      const outcomes = t.seen.flatMap(e => e.type === "outcome" && e.playback.reason !== "shutdown" ? [e] : []);
      c.assert(JSON.stringify(outcomes.map(e => e.session_id)) === JSON.stringify(expected)); // R78/R79: admission order, exact reach, once each.
      c.assert(outcomes.every(e => e.playback.reason === (scope === "queue" ? "cancel" : e.session_id === t.playing ? "stop" : "stop_preparing"))); // R79/L165: mapped reasons.
      c.assert(t.seen.filter(e => e.type === "control_ack" && e.command_id === ack.command_id).length === 1); // R79/L172: one ack.
    }
    const t = await fixture(c);
    const ack = await control(c, t, t.held, "stop", { scope: "all_speech", reason: "cancel", except_sessions: [t.held] });
    c.assert(ack.outcome === "accept"); // R80: spared addressed read, other reads ended.
    await t.finish();
    c.assert(!t.seen.some(e => e.type === "outcome" && e.session_id === t.held && e.playback.reason !== "shutdown")); // R78.
  },
  "PREEMPT-01e": async c => {
    const t = await fixture(c), command_id = "replace-command";
    t.backend.script(Array.from({ length: 1 }, () => ({ latency_ms: 2, late_after_cancel: false, result: { kind: "audio" as const, ...pcmAudio(100) } })));
    t.connection.send({ protocol: "nl.engine/1", type: "control", command_id, session_id: t.playing, op: "stop", args: { scope: "session", reason: "replaced" } });
    narrate(t, "successor"); // R81/L345: same turn, no teardown wait in engine.
    const successor = await admitted(c, t, "successor");
    await until(c, () => t.seen.some(e => e.type === "piece_ready" && e.session_id === successor));
    feedback(c, t, successor, "spawned"); feedback(c, t, successor, "first_sample"); feedback(c, t, successor, "exited");
    await until(c, () => t.seen.some(e => e.type === "outcome" && e.session_id === successor));
    await t.finish();
    const ends = t.seen.flatMap(e => e.type === "outcome" && e.session_id === t.playing ? [e] : []);
    c.assert(ends.length === 1 && ends[0].playback.reason === "replaced"); // R81/L522: exactly one replaced outcome.
    c.assert(!t.seen.slice(t.seen.indexOf(ends[0]) + 1).some(e => "session_id" in e && e.session_id === t.playing)); // R81: no piece, timing, duration or lifecycle after outcome.
    c.assert(t.seen.some(e => e.type === "outcome" && e.session_id === successor && e.playback.reason === "completed")); // R81: successor finishes by feedback.
    c.assert(t.seen.filter(e => e.type === "control_ack" && e.command_id === command_id).length === 1); // R79.
  },
};

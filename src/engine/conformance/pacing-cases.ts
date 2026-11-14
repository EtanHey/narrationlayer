import type { Case, CaseContext } from "./runner";
import type { BackendStep, Json } from "./binding";
import { setup, success, interrupted, assertBackendCalls } from "./engine-cases";
import { pcmAudio } from "./fake-backend";
type Rig = ReturnType<typeof setup>;
const sentences = ["Amber rafts float.", "Violet cranes glide.", "Golden otters swim.", "Copper boats drift.", "Silver herons wade.", "Crimson foxes rest."];
const audio = (): BackendStep => ({ latency_ms: 2, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(100) } });
const read = (id: string, count: number, extra: Record<string, Json> = {}) => ({ protocol: "nl.engine/1", type: "narrate", request_id: id, idempotency_key: id, use: "read", input: { text: sentences.slice(0, count).join(" "), format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", ...extra });
const tick = async (t: Rig, ms = 12) => { for (let i = 0; i < ms; i++) await t.settle(1); };
function sid(c: CaseContext, t: Rig, request: string) {
  const e = t.seen.find(e => e.type === "accepted" && e.request_id === request);
  c.assert(e?.type === "accepted"); if (e?.type !== "accepted") throw new Error("missing admission"); return e.session_id;
}
const pieces = (t: Rig, id: string) => t.seen.filter(e => e.type === "piece_ready").filter(e => e.session_id === id);
function feedback(c: CaseContext, t: Rig, id: string, index: number, edges: string[]) {
  for (const edge of edges) t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: id, piece_index: index, control_epoch: index + 1, player_instance_id: `player-${index}`, edge, t_mono_ms: c.clock.now(), source: "player_reported", ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: 100 * (index + 1) } } : {}) });
}
function stop(t: Rig, id: string, command = "stop-command", reason = "stop") {
  t.connection.send({ protocol: "nl.engine/1", type: "control", session_id: id, command_id: command, op: "stop", args: { scope: "session", reason } });
}
async function play(c: CaseContext, t: Rig, id: string, count: number) {
  for (let i = 0; i < count; i++) {
    c.assert(pieces(t, id).some(p => p.index === i));
    feedback(c, t, id, i, ["spawned", "first_sample"]); await tick(t);
    feedback(c, t, id, i, ["last_sample", "exited"]); await tick(t, 1);
  }
}
export const pacingCases: Record<string, Case> = {
  "PACE-01": async c => {
    for (const lookahead of [2, 1, 5]) {
      const t = setup(c, Array.from({ length: 6 }, audio));
      let active = 0; const synthesize = t.backend.synthesizeRequest.bind(t.backend);
      t.backend.synthesizeRequest = (request, signal) => { c.assert(++active === 1); return synthesize(request, signal).finally(() => { active--; }); };
      t.connection.send(read(`pace-${lookahead}`, 6, lookahead === 2 ? {} : { lookahead })); await tick(t);
      const id = sid(c, t, `pace-${lookahead}`); let playing = 0, cursor = 0, inFlight = false;
      const check = () => {
        for (const e of t.seen.slice(cursor)) {
          if (e.type === "piece_ready") c.assert(e.index <= playing + lookahead);
          if (e.type === "lifecycle" && e.edge === "synthesis_requested") { c.assert(!inFlight); inFlight = true; c.assert(e.piece_index <= playing + lookahead); }
          if (e.type === "lifecycle" && e.edge === "audio_ready") { c.assert(inFlight); inFlight = false; }
        }
        cursor = t.seen.length;
        c.assert(t.backend.calls.length === t.seen.filter(e => e.type === "lifecycle" && e.edge === "synthesis_requested").length);
        c.assert(pieces(t, id).length === Math.min(6, playing + lookahead + 1));
      };
      check();
      for (let i = 0; i < 6; i++) {
        c.assert(pieces(t, id).some(p => p.index === i));
        playing = i; feedback(c, t, id, i, ["spawned"]); await tick(t, 1);
        feedback(c, t, id, i, ["first_sample"]); await tick(t); check();
        feedback(c, t, id, i, ["last_sample", "exited"]); await tick(t, 1); check();
      }
      await t.finish(); success(c, t.seen, `pace-${lookahead}`, 6, t.backend.calls);
    }
  },
  "PACE-02": async c => {
    for (const early of [false, true]) {
    const t = setup(c, Array.from({ length: 12 }, audio));
    t.connection.send(read("queue-first", 6)); await tick(t, 1);
    const first = sid(c, t, "queue-first");
    t.connection.send(read("queue-second", 3, { start: { after_session: first } })); await tick(t, 1);
    const second = sid(c, t, "queue-second");
    t.connection.send(read("queue-third", 3, { start: { after_session: second } })); await tick(t);
    const third = sid(c, t, "queue-third");
    for (const id of [second, third]) c.assert(t.seen.some(e => e.type === "plan" && e.session_id === id) && pieces(t, id).length === 0);
    c.assert(t.backend.calls.length === 3);
    for (let i = 0; i < 6; i++) {
      feedback(c, t, first, i, ["spawned", "first_sample"]); await tick(t);
      c.assert(pieces(t, second).length === (early && i > 3 ? 3 : i >= 3 ? 1 : 0) && pieces(t, third).length === (early && i > 3 ? 1 : 0));
      if (i === 3) {
        feedback(c, t, second, 0, ["spawned"]); await tick(t); c.assert(pieces(t, second).length === 1);
        if (early) { feedback(c, t, second, 0, ["first_sample"]); await tick(t); c.assert(pieces(t, second).length === 3 && !t.seen.some(e => e.type === "outcome" && e.session_id === first)); }
      }
      feedback(c, t, first, i, ["last_sample", "exited"]); await tick(t, 1);
    }
    c.assert(pieces(t, second).length === (early ? 3 : 1));
    if (!early) { feedback(c, t, second, 0, ["first_sample"]); await tick(t); }
    c.assert(pieces(t, second).length === 3 && pieces(t, third).length === 1);
    feedback(c, t, second, 0, ["last_sample", "exited"]); await tick(t, 1);
    for (let i = 1; i < 3; i++) { feedback(c, t, second, i, ["spawned", "first_sample"]); await tick(t); c.assert(pieces(t, third).length === 1); feedback(c, t, second, i, ["last_sample", "exited"]); await tick(t, 1); }
    await play(c, t, third, 3); await t.finish();
    for (const [request, count] of [["queue-first", 6], ["queue-second", 3], ["queue-third", 3]] as const) success(c, t.seen, request, count, t.backend.calls);
    }
    for (const ending of ["stop", "failure"]) {
      const u = setup(c, [{ ...audio(), latency_ms: 5, ...(ending === "failure" ? { result: { kind: "error", code: "invented failure" } as const } : {}) }, audio()]);
      u.connection.send(read(`predecessor-${ending}`, 6)); await tick(u, 1);
      const prior = sid(c, u, `predecessor-${ending}`);
      u.connection.send(read(`dependent-${ending}`, 1, { start: { after_session: prior } }));
      if (ending === "stop") stop(u, prior);
      await tick(u); const dependent = sid(c, u, `dependent-${ending}`);
      c.assert(pieces(u, dependent).length === 1 && u.seen.some(e => e.type === "outcome" && e.session_id === prior && e.playback.reason === (ending === "stop" ? "stop_preparing" : "synth_failed")));
      await play(c, u, dependent, 1); await u.finish();
      interrupted(c, u.seen, `predecessor-${ending}`, 0, ending === "stop" ? "cancelled" : "failed", u.backend.calls);
      const outcomes = u.seen.filter(e => e.type === "outcome").filter(e => e.session_id === dependent);
      c.assert(outcomes.length === 1 && outcomes[0].generation.status === "committed" && outcomes[0].playback.reason === "completed");
      assertBackendCalls(c, u.seen, u.backend.calls, dependent, pieces(u, dependent));
    }
    const unknown = setup(c, []); unknown.connection.send(read("unknown-predecessor", 3, { start: { after_session: "session-1-99" } })); await tick(unknown, 30);
    const waiting = sid(c, unknown, "unknown-predecessor");
    c.assert(unknown.seen.some(e => e.type === "plan" && e.session_id === waiting) && pieces(unknown, waiting).length === 0 && unknown.backend.calls.length === 0);
    stop(unknown, waiting); await tick(unknown); await unknown.finish();
    c.assert(unknown.seen.filter(e => e.type === "outcome" && e.session_id === waiting).length === 1);
  },
  "CTRL-01": async c => {
    const t = setup(c, [audio(), audio()]); t.connection.send(read("receipt-first", 1)); await tick(t);
    const id = sid(c, t, "receipt-first"), acks = () => t.seen.filter(e => e.type === "control_ack");
    stop(t, id, "cmd-1"); await tick(t, 1); const original = acks().at(-1); c.assert(original?.outcome === "accept");
    stop(t, id, "cmd-1"); await tick(t, 1); c.assert(JSON.stringify(acks().at(-1)) === JSON.stringify(original));
    const outcomes = t.seen.filter(e => e.type === "outcome"), beforeConflict = t.seen.length;
    stop(t, id, "cmd-1", "cancel"); await tick(t, 1);
    c.assert(t.seen.length === beforeConflict + 1 && acks().at(-1)?.outcome === "reject" && acks().at(-1)?.reason === "command id reused" && t.seen.filter(e => e.type === "outcome").length === outcomes.length);
    for (let i = 2; i <= 34; i++) { stop(t, id, `cmd-${i}`); await tick(t, 1); }
    c.assert(acks().length === 36);
    // Inspect all 32 retained receipts before inserting another id and evicting one.
    for (let i = 3; i <= 34; i++) {
      const original = acks().find(e => e.command_id === `cmd-${i}`); stop(t, id, `cmd-${i}`); await tick(t, 1);
      c.assert(JSON.stringify(acks().at(-1)) === JSON.stringify(original));
    }
    for (const command of ["cmd-2", "cmd-1"]) { stop(t, id, command); await tick(t, 1); c.assert(acks().at(-1)?.outcome === "noop" && acks().at(-1)?.seq !== acks().find(e => e.command_id === command)?.seq); }
    t.connection.send(read("receipt-second", 1)); await tick(t);
    stop(t, sid(c, t, "receipt-second"), "cmd-34"); await tick(t, 1); c.assert(acks().at(-1)?.outcome === "accept");
    await t.finish();
    const numbered = c.trace.filter((e): e is { [key: string]: Json } => !!e && typeof e === "object" && !Array.isArray(e) && typeof e.seq === "number");
    let seq = 0; const receipts = new Map<number, string>();
    for (const e of numbered) {
      if (receipts.has(Number(e.seq))) c.assert(e.type === "control_ack" && receipts.get(Number(e.seq)) === JSON.stringify(e));
      else { c.assert(e.seq === ++seq); receipts.set(Number(e.seq), JSON.stringify(e)); }
    }
  },
  "SESS-01": async c => {
    const t = setup(c, [audio()]); t.connection.send(read("known-read", 1)); await tick(t);
    const known = sid(c, t, "known-read");
    for (const unknown of ["invented-session", "session-1-99"]) {
      let before = t.seen.length; feedback(c, t, unknown, 0, ["spawned", "first_sample", "exited"]); await tick(t, 1); c.assert(t.seen.length === before);
      stop(t, unknown); await tick(t, 1); const emitted = t.seen.slice(before);
      c.assert(emitted.length === 1 && emitted[0].type === "error" && emitted[0].code === "UNKNOWN_SESSION" && emitted[0].phase === "control" && emitted[0].retry === "never" && emitted[0].session_id === unknown);
    }
    await play(c, t, known, 1);
    const outcome = t.seen.find(e => e.type === "outcome"); c.assert(outcome?.type === "outcome" && outcome.playback.reason === "completed" && outcome.generation.status === "committed");
    stop(t, known, "ended-stop"); await tick(t, 1); c.assert(t.seen.at(-1)?.type === "control_ack" && t.seen.filter(e => e.type === "control_ack").at(-1)?.outcome === "noop");
    t.connection.send({ protocol: "nl.engine/1", type: "hello", client: { name: "synthetic", version: "1" }, binding: "in-process", stage: "A", required_caps: [] }); await tick(t, 1);
    c.assert(t.seen.at(-1)?.type === "error" && t.seen.filter(e => e.type === "error").at(-1)?.code === "INVALID_REQUEST"); await t.finish();
  },
  "ID-05e": async c => {
    for (const count of [1, 3]) for (const endFirst of [true, false]) for (const gap of ["turn", "microtask", "millisecond"]) {
      const t = setup(c, Array.from({ length: count }, audio)); t.connection.send(read("race-read", count)); await tick(t);
      const id = sid(c, t, "race-read");
      for (let i = 0; i < count - 1; i++) feedback(c, t, id, i, ["spawned", "first_sample", "last_sample", "exited"]);
      feedback(c, t, id, count - 1, ["spawned", "first_sample", "last_sample"]); await tick(t, 1);
      const end = () => feedback(c, t, id, count - 1, ["exited"]), halt = () => stop(t, id);
      (endFirst ? end : halt)();
      if (gap === "microtask") await Promise.resolve(); else if (gap === "millisecond") await tick(t, 1);
      (endFirst ? halt : end)(); await tick(t);
      feedback(c, t, id, count - 1, ["exited"]); await tick(t); await t.finish();
      const own = t.seen.filter(e => "session_id" in e && e.session_id === id), outcomes = own.filter(e => e.type === "outcome"), acks = t.seen.filter(e => e.type === "control_ack");
      c.assert(outcomes.length === 1 && outcomes[0].playback.reason === (endFirst ? "completed" : "stop") && outcomes[0].generation.status === "committed");
      c.assert(acks.length === 1 && acks[0].outcome === (endFirst ? "noop" : "accept"));
      // A command receipt may follow natural completion; session data may not.
      c.assert(own.slice(own.indexOf(outcomes[0]) + 1).every(e => e.type === "control_ack"));
    }
  },
};

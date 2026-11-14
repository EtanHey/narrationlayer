import { createHash } from "node:crypto";
import type { Case, CaseContext } from "./runner";
import type { BackendStep, Json } from "./binding";
import type { Message } from "../messages/messages";
import { setup, success, interrupted, until } from "./engine-cases";
import { pcmAudio } from "./fake-backend";
const text = "Amber rafts float. Violet cranes glide. Golden otters swim.";
const read = (id: string) => ({ protocol: "nl.engine/1", type: "narrate", request_id: id, idempotency_key: id, use: "read", input: { text, format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", lookahead: 3 });
const script = (read = 0): BackendStep[] => [31, 47, 63].map(n => n + read * 101).map(n => ({ latency_ms: 2, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(n, 1000, n) } }));
function fixture(c: CaseContext, steps = [...script(), ...script(1), ...script(2).slice(0, 1), { latency_ms: 2, late_after_cancel: true, result: { kind: "audio", ...pcmAudio(79) } } satisfies BackendStep]) {
  let store = new Map<string, Uint8Array>();
  const create = c.binding.create;
  c.binding.create = host => { store = host.store; return create(host); };
  const t = setup(c, steps); c.binding.create = create;
  c.assert(typeof t.connection.resolve === "function");
  const released = new Set<string>();
  const pieces = () => t.seen.filter(e => e.type === "piece_ready");
  const release = async (p: Message<"piece_ready">, settle = true) => {
    t.connection.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: p.artifact.lease_id });
    released.add(p.artifact.lease_id); if (settle) await t.settle(); check();
  };
  const check = () => {
    for (const p of pieces()) {
      const result = t.connection.resolve!(p.artifact.handle, p.artifact.lease_id);
      if (released.has(p.artifact.lease_id)) { c.assert(result.kind === "expired"); continue; }
      const ordinal = t.seen.filter(e => e.type === "accepted").findIndex(e => e.session_id === p.session_id);
      const expected = script(ordinal)[p.index].result; c.assert(expected.kind === "audio");
      if (expected.kind !== "audio") continue;
      c.assert(result.kind === "resolved");
      if (result.kind !== "resolved") continue;
      c.assert(result.bytes.length === expected.bytes.length && result.bytes.every((v, i) => v === expected.bytes[i]));
      c.assert(p.artifact.sha256 === createHash("sha256").update(expected.bytes).digest("hex"));
      result.bytes.fill(0);
      const again = t.connection.resolve!(p.artifact.handle, p.artifact.lease_id);
      c.assert(again.kind === "resolved" && again.bytes.every((v, i) => v === expected.bytes[i]));
    }
  };
  const outcome = (id: string) => {
    const accepted = t.seen.find(e => e.type === "accepted" && e.request_id === id); c.assert(accepted?.type === "accepted");
    if (accepted?.type !== "accepted") return;
    const out = t.seen.filter(e => e.type === "outcome").filter(e => e.session_id === accepted.session_id); c.assert(out.length === 1);
    c.assert(JSON.stringify(out[0].artifacts) === JSON.stringify(pieces().filter(p => p.session_id === accepted.session_id && !released.has(p.artifact.lease_id)).map(p => ({ piece_id: p.piece_id, handle: p.artifact.handle, lease_id: p.artifact.lease_id }))));
  };
  const complete = async (id: string) => {
    for (let i = 0; i < 12; i++) await t.settle(1);
    const a = t.seen.find(e => e.type === "accepted" && e.request_id === id); c.assert(a?.type === "accepted");
    if (a?.type !== "accepted") return;
    for (const p of pieces().filter(p => p.session_id === a.session_id)) for (const edge of ["spawned", "first_sample", "exited"]) t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: p.session_id, player_instance_id: `artifact-player-${p.index}`, control_epoch: p.index + 1, piece_index: p.index, edge, t_mono_ms: c.clock.now(), ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: p.start_ms + p.duration_ms } } : {}) });
    await until(c, () => t.seen.some(e => e.type === "outcome" && e.session_id === a.session_id)); success(c, t.seen, id, 3, t.backend.calls); outcome(id);
  };
  return { ...t, pieces, release, check, complete, outcome, released, store };
}
async function endings(c: CaseContext) {
  for (const end of ["completed", "stop", "failure", "shutdown"]) for (const same of [false, true]) {
    const steps = end === "failure" ? [...script().slice(0, 2), { latency_ms: 2, late_after_cancel: false, result: { kind: "error", code: "invented" } } satisfies BackendStep]
      : (end === "stop" || end === "shutdown") ? [...script().slice(0, 2), { ...script()[2], late_after_cancel: true }] : script();
    const t = fixture(c, steps); t.connection.send(read("artifact-end"));
    const count = end === "failure" ? 2 : (end === "stop" || end === "shutdown") ? 2 : 3;
    for (let i = 0; i < 12 && t.pieces().length < count; i++) await t.settle(1);
    c.assert(t.pieces().length === count); t.check();
    if (end === "stop" || end === "shutdown") await until(c, () => t.backend.calls.length === count + 1);
    // Arm the final playback edge, keeping the terminal out of the trace until release.
    if (end === "completed" || end === "stop") for (const p of t.pieces()) for (const edge of ["spawned", "first_sample", ...(p.index < count - 1 ? ["exited"] : [])])
      t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: p.session_id, player_instance_id: `end-${p.index}`, control_epoch: p.index + 1, piece_index: p.index, edge, t_mono_ms: c.clock.now(), ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: p.start_ms + p.duration_ms } } : {}) });
    if (same) void t.release(t.pieces()[0], false); else await t.release(t.pieces()[0]);
    c.assert(t.connection.resolve!(t.pieces()[0].artifact.handle, t.pieces()[0].artifact.lease_id).kind === "expired");
    const last = t.pieces().at(-1)!;
    if (end === "completed") t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: last.session_id, player_instance_id: `end-${last.index}`, control_epoch: last.index + 1, piece_index: last.index, edge: "exited", t_mono_ms: c.clock.now(), exit: { status: "completed", stopped_at_ms: last.start_ms + last.duration_ms } });
    if (end === "stop") t.connection.send({ protocol: "nl.engine/1", type: "control", command_id: "end-stop", session_id: last.session_id, op: "stop", args: { scope: "session", reason: "stop" } });
    if (end === "shutdown") void t.connection.shutdown(c.clock.now());
    // For failure the next clock edge delivers the scripted error; no unbounded wait.
    for (let i = 0; i < 8; i++) await t.settle(1);
    if (end === "completed") success(c, t.seen, "artifact-end", 3, t.backend.calls);
    else interrupted(c, t.seen, "artifact-end", count, end === "failure" ? "failed" : end === "shutdown" ? "interrupted" : "cancelled", t.backend.calls);
    t.outcome("artifact-end"); t.check(); await t.finish(); t.check();
  }
}
export const artifactCases: Record<string, Case> = {
  "SHUT-01": async c => {
    for (const mode of ["partial", "generated", "multiple", "stuck", "now", "mixed"]) {
      const stuck = mode === "stuck" || mode === "now" || mode === "mixed";
      const steps = mode === "mixed" ? [{ ...script()[0], latency_ms: 10000, late_after_cancel: true }, { ...script(1)[0], latency_ms: 10000, late_after_cancel: true }] : stuck ? [{ ...script()[0], latency_ms: 10000, late_after_cancel: true }] : mode === "partial" ? script().slice(0, 2) : mode === "multiple" ? [...script(), ...script(1)] : script();
      const traceStart = c.trace.length;
      const t = fixture(c, []), synthesize = t.backend.synthesizeRequest.bind(t.backend), counts = new Map<number, number>();
      t.backend.synthesizeRequest = (request, signal) => {
        const index = request && typeof request === "object" && !Array.isArray(request) ? Number(request.piece_index) : 0;
        const ordinal = counts.get(index) ?? 0; counts.set(index, ordinal + 1);
        t.backend.script([mode === "multiple" ? script(ordinal)[index] : steps[t.backend.calls.length]]);
        return synthesize(request, signal);
      };
      t.connection.send(read("shutdown-one"));
      if (mode === "multiple" || mode === "mixed") t.connection.send(read("shutdown-two"));
      await until(c, () => mode === "generated" ? t.pieces().length === 3 : mode === "partial" ? t.pieces().length === 1 : t.backend.calls.length >= 1); // L76/430: serial synthesis is allowed.
      if (mode === "multiple") {
        await until(c, () => t.seen.some(e => e.type === "accepted"));
        const first = t.seen.find(e => e.type === "accepted"); c.assert(first?.type === "accepted");
        if (first?.type === "accepted") t.connection.send({ ...read("shutdown-queued"), start: { after_session: first.session_id } });
      }
      const expectedCount = mode === "multiple" ? 3 : mode === "mixed" ? 2 : 1;
      t.check();
      let done = false, rejected = false, ended = false;
      const deadline = c.clock.now() + (mode === "now" ? 0 : 30);
      const pending = t.connection.shutdown(deadline).then(() => { done = true; }, () => { rejected = true; });
      await t.settle(); t.check();
      await until(c, () => t.seen.filter(e => e.type === "outcome").length === expectedCount && t.seen.filter(e => e.type === "accepted").length === expectedCount);
      const end = t.connection.events[Symbol.asyncIterator]().next().then(r => { ended = r.done === true; });
      const outcomes = t.seen.filter(e => e.type === "outcome");
      c.assert(outcomes.length === expectedCount);
      const raw = c.trace.slice(traceStart);
      const firstEnd = raw.findIndex(e => e !== null && typeof e === "object" && !Array.isArray(e) && e.type === "outcome" && e.playback !== null && typeof e.playback === "object" && !Array.isArray(e.playback) && e.playback.reason === "shutdown");
      c.assert(firstEnd >= 0 && raw.slice(firstEnd).every(e => e !== null && typeof e === "object" && !Array.isArray(e) && e.type === "outcome"));
      for (const out of outcomes) {
        c.assert(out.playback.reason === "shutdown");
        const pieces = t.pieces().filter(p => p.session_id === out.session_id);
        c.assert(out.generation.status === (pieces.length === 3 ? "committed" : "interrupted"));
        const accepted = t.seen.find(e => e.type === "accepted" && e.session_id === out.session_id);
        if (accepted?.type === "accepted") t.outcome(accepted.request_id);
        c.assert(JSON.stringify(out.missing_piece_indices) === JSON.stringify([0, 1, 2].filter(i => !pieces.some(p => p.index === i))));
      }
      if (mode === "stuck" || mode === "mixed") { c.assert(!done); await t.settle(deadline - c.clock.now() - 1); c.assert(!done); await t.settle(1); }
      await until(c, () => ended);
      c.assert(done && !rejected && ended); await pending; await end; t.check();
      const length = c.trace.length;
      for (const p of t.pieces()) { await t.release(p); await t.release(p); }
      t.check(); c.assert(t.store.size === 0);
      t.connection.send(read("shutdown-late")); await t.settle(50);
      c.assert(c.trace.length === length);
      let twice = false; void t.connection.shutdown(c.clock.now()).then(() => { twice = true; }); await t.settle(); c.assert(twice);
      // Only now let the intentionally unresponsive fixture settle for harness cleanup.
      if (stuck) await t.settle(10000);
      await t.finish();
    }
    // Host feedback can reach the one-microtask gap before publication commit.
    let completed = 0;
    for (let offset = 0; offset < 4; offset++) {
      const t = fixture(c, script().slice(0, 1)), set = t.store.set.bind(t.store);
      t.store.set = (handle, bytes) => {
        const result = set(handle, bytes); let remaining = offset;
        const end = () => {
          if (remaining > 0) { remaining--; queueMicrotask(end); return; }
          const accepted = t.seen.find(e => e.type === "accepted");
          if (accepted?.type !== "accepted") { c.clock.schedule(1, end); return; } // L114: admission may still be in transit.
          for (const edge of ["spawned", "first_sample", "exited"]) t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: accepted.session_id, player_instance_id: "terminal-player", control_epoch: 1, piece_index: 0, edge, t_mono_ms: c.clock.now(), ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: 31 } } : {}) });
          void t.connection.shutdown(c.clock.now());
        };
        queueMicrotask(end); return result;
      };
      t.connection.send({ ...read("shutdown-terminal"), input: { text: "Copper boats drift.", format: "plain" } });
      await until(c, () => t.seen.some(e => e.type === "outcome")); const outcomes = t.seen.filter(e => e.type === "outcome"); c.assert(outcomes.length === 1);
      const out = outcomes[0];
      if (out.heard) { completed++; c.assert(out.playback.reason === "completed" && out.generation.status === "committed"); }
      else c.assert(out.playback.reason === "shutdown" && out.generation.status === "interrupted");
      t.check(); for (const p of t.pieces()) await t.release(p); await t.finish();
    }
    c.assert(completed > 0);
  },
  "ART-01": async c => {
    // L545/114: a delivered prefix may include more than the next awaited piece.
    const t = fixture(c); t.connection.send(read("artifact-first"));
    for (let n = 1; n <= 3; n++) {
      await until(c, () => t.pieces().length >= n); // L545: observe the requested prefix.
      c.assert(t.pieces().length >= n); t.check();
      if (n === 2) { await t.release(t.pieces()[0]); c.assert(t.pieces().length >= 2); t.check(); }
    }
    await t.complete("artifact-first"); t.check();
    t.connection.send(read("artifact-second")); await t.complete("artifact-second"); t.check();
    t.connection.send(read("artifact-stop"));
    await until(c, () => t.pieces().length >= 7); // L545: wait for the third read's first piece.
    c.assert(t.pieces().length === 7);
    await until(c, () => t.backend.calls.length === 8); // L425: cancel an actually started call.
    const p = t.pieces()[6];
    t.connection.send({ protocol: "nl.engine/1", type: "control", command_id: "artifact-stop", session_id: p.session_id, op: "stop", args: { scope: "session", reason: "stop" } });
    await t.settle(3); interrupted(c, t.seen, "artifact-stop", 1, "cancelled", t.backend.calls); t.outcome("artifact-stop"); t.check();
    await t.finish(); t.check();
    await endings(c);
    c.assert(t.store.size === t.pieces().length - t.released.size);
    const live = fixture(c, [...script(), ...script(1)]);
    for (const id of ["artifact-first", "artifact-second"]) { live.connection.send(read(id)); await live.complete(id); }
    for (const p of live.pieces()) await live.release(p);
    live.check(); c.assert(live.store.size === 0); await live.finish();
  },
  "ART-04": async c => {
    const t = fixture(c, [...script(), ...script(1)]);
    t.connection.send(read("artifact-first"));
    for (let i = 0; i < 8 && t.pieces().length < 2; i++) await t.settle(1);
    c.assert(t.pieces().length === 2);
    const [a, b] = t.pieces();
    c.assert(t.connection.resolve!(b.artifact.handle, a.artifact.lease_id).kind === "expired"); t.check();
    const before = c.trace.length; await t.release(a); c.assert(c.trace.length === before); t.check();
    const expired = async (lease_id: string, known: boolean) => {
      const start = t.seen.filter(e => e.type === "error").length;
      t.connection.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id }); await until(c, () => t.seen.filter(e => e.type === "error").length > start);
      c.assert(t.seen.filter(e => e.type === "error").length === start + 1); // L353: unrelated session events may interleave.
      const e = t.seen.filter(e => e.type === "error").at(-1); c.assert(e?.type === "error");
      if (e?.type !== "error") return;
      c.assert(e.code === "ARTIFACT_EXPIRED" && e.phase === "retain" && e.retry === "never" && e.session_id === undefined && e.request_id === undefined);
      c.assert(JSON.stringify(e.details) === (known ? JSON.stringify({ lease_id }) : undefined));
    };
    await expired(a.artifact.lease_id, true);
    const canary = "quartzFalconRiverMeadowX"; c.assert(canary.length === 24);
    await expired(canary, false);
    const raw = JSON.stringify(c.trace); for (let i = 0; i <= canary.length - 8; i++) c.assert(!raw.includes(canary.slice(i, i + 8)));
    // The shared success receipt rejects uncorrelated errors; check the deliberate refusals
    // separately above, then pass the successful read's complete session trace.
    const errors = t.seen.filter(e => e.type === "error"); t.seen.splice(0, t.seen.length, ...t.seen.filter(e => e.type !== "error"));
    await t.complete("artifact-first"); t.check();
    t.connection.send(read("artifact-second")); await t.complete("artifact-second");
    await t.release(b); t.check();
    for (const p of t.pieces()) if (!t.released.has(p.artifact.lease_id)) await t.release(p);
    t.check(); c.assert(t.store.size === 0); c.assert(errors.length === 2);
    await t.finish();
    c.assert(c.trace.filter(e => e && typeof e === "object" && !Array.isArray(e) && e.type === "error").length === 2);
  },
};

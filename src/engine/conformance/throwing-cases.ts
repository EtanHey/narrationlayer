import type { Case } from "./runner";
import type { Binding } from "./binding";
import { setup, until } from "./engine-cases";
import { pcmAudio } from "./fake-backend";
import { trapState } from "./wall-guard";
const read = (id: string) => ({ protocol: "nl.engine/1", type: "narrate", request_id: id, idempotency_key: id, use: "read", input: { text: "Copper boats drift.", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" } as const);
/** L429/558, R99-103: one-shot faults, recovery on the same connection, fake-clock bounds. */
export const throwingCases: Record<string, Case> = { "BIND-03": async c => {
  const exits = trapState.violations.filter(v => v.kind === "exit").length;
  for (const fault of ["emit", "outcome", "monotonic", "schedule", "backend", "rejection", "store.has", "store.set", "store.get", "store.delete", "cancel", "log"]) {
    const create = c.binding.create, logs: unknown[] = []; let armed = false, thrown = false;
    const fail = () => { if (armed && !thrown) { thrown = true; throw new TypeError("Copper boats drift."); } };
    c.binding.create = host => {
      const clock = host.clock;
      const wrapped: Parameters<Binding["create"]>[0] = { ...host, synthesis_timeout_ms: 91, clock: {
        now: () => clock.now(), monotonic: () => { if (fault === "monotonic") fail(); return clock.monotonic(); },
        schedule(ms, callback) { if (fault === "schedule" && ms === 91) fail(); const cancel = clock.schedule(ms, callback); return () => { cancel(); if (fault === "cancel") fail(); }; },
      }, observe: { event(event) { if (fault === "emit" || fault === "log" || fault === "outcome" && event && typeof event === "object" && "type" in event && event.type === "outcome") fail(); } },
      log(entry) { logs.push(entry); if (fault === "log") throw Error("Copper boats drift."); } };
      for (const method of ["has", "set", "get", "delete"] as const) {
        const original = host.store[method].bind(host.store);
        if (fault === `store.${method}`) Reflect.set(host.store, method, (...args: unknown[]) => { fail(); return Reflect.apply(original, host.store, args); });
      }
      if (host.ports && (fault === "backend" || fault === "rejection")) {
        const original = host.ports.backend.synthesizeRequest.bind(host.ports.backend);
        host.ports.backend.synthesizeRequest = (r, signal) => { if (armed && !thrown) { if (fault === "rejection") { thrown = true; return Promise.reject(new TypeError("Copper boats drift.")); } fail(); } return original(r, signal); };
      }
      return create(wrapped);
    };
    const step = { latency_ms: 1, late_after_cancel: false, result: { kind: "audio" as const, ...pcmAudio(100, 1000, 300) } };
    const t = setup(c, [step]); c.binding.create = create; armed = true;
    t.connection.send(read("fault-read")); // R102: a throw cannot escape send.
    const parallel = fault === "monotonic" || fault === "schedule";
    if (parallel) t.connection.send(read("parallel-read"));
    await until(c, () => t.seen.some(e => e.type === "piece_ready" || e.type === "outcome"));
    async function complete(id: string) {
      const accepted = t.seen.find(e => e.type === "accepted" && e.request_id === id); c.assert(accepted?.type === "accepted"); if (accepted?.type !== "accepted") return;
      await until(c, () => t.seen.some(e => (e.type === "piece_ready" || e.type === "outcome") && e.session_id === accepted.session_id));
      for (const piece of t.seen.filter(e => e.type === "piece_ready" && e.session_id === accepted.session_id)) {
        if (piece.type !== "piece_ready") continue;
        if (fault === "store.get" && id === "fault-read") t.connection.resolve?.(piece.artifact.handle, piece.artifact.lease_id);
        t.connection.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: piece.artifact.lease_id });
        for (const edge of ["spawned", "first_sample", "exited"]) t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: accepted.session_id, piece_index: piece.index, player_instance_id: id, control_epoch: 1, edge, t_mono_ms: c.clock.now(), ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: piece.start_ms + piece.duration_ms } } : {}) });
      }
      await until(c, () => t.seen.some(e => e.type === "outcome" && e.session_id === accepted.session_id));
      c.assert(t.seen.filter(e => e.type === "outcome" && e.session_id === accepted.session_id).length === 1); // R100: thrown outcome still terminal.
    }
    await complete("fault-read"); c.assert(thrown);
    const failed = t.seen.find(e => e.type === "accepted" && e.request_id === "fault-read");
    c.assert(failed?.type === "accepted");
    const errors = t.seen.filter(e => e.type === "error" && e.session_id === failed?.session_id);
    if (["monotonic", "schedule", "store.has", "store.set"].includes(fault)) {
      c.assert(errors.some(e => e.type === "error" && e.code === "HOST_CALLBACK_FAILED"
        && e.phase === (fault.startsWith("store.") ? "deliver" : "synthesize") && e.retry === "new_request"));
    } else if (fault === "backend" || fault === "rejection") {
      c.assert(errors.some(e => e.type === "error" && e.code === "SYNTH_FAILED" && e.phase === "synthesize"));
    } else c.assert(errors.length === 0); // Includes a throwing logger and class (c) resolve.

    if (parallel) {
      await complete("parallel-read");
      const other = t.seen.find(e => e.type === "accepted" && e.request_id === "parallel-read");
      c.assert(t.seen.some(e => e.type === "outcome" && e.session_id === other?.session_id && e.generation.status === "committed"));
      c.assert(!t.seen.some(e => e.type === "error" && e.session_id === other?.session_id));
    }
    if (t.backend.pending === 0) t.backend.script([step]); // L429/558, R90: either backend/bound order is valid.
    t.connection.send(read("healthy-read")); await until(c, () => t.seen.filter(e => e.type === "accepted").length === (parallel ? 3 : 2) && t.seen.some(e => e.type === "piece_ready" && e.session_id === t.seen.find(e => e.type === "accepted" && e.request_id === "healthy-read")?.session_id));
    await complete("healthy-read");
    const healthy = t.seen.find(e => e.type === "accepted" && e.request_id === "healthy-read");
    c.assert(!t.seen.some(e => e.type === "error" && e.session_id === healthy?.session_id));
    c.assert(t.seen.some(e => e.type === "outcome" && e.session_id === healthy?.session_id && e.generation.status === "committed"));
    await t.finish();
    c.assert(logs.length > 0); c.assert(!JSON.stringify(logs).includes("Copper boats drift.")); // R103
  }
  c.assert(trapState.violations.filter(v => v.kind === "exit").length === exits); // Harness owns rejection recording.
} };

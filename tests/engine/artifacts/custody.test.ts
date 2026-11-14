import { hello } from "../../../src/engine/conformance/engine-cases";
import { expect, test } from "bun:test";
import { createArtifactStore } from "../../../src/engine/artifacts/store";
import { createPublication } from "../../../src/engine/publication/publication";
import { createEngineSession, type ReadPlanner } from "../../../src/engine/session/session";
import { ScriptedBackend, pcmAudio } from "../../../src/engine/conformance/fake-backend";
import { FakeClock } from "../../../src/engine/conformance/clock";
import type { Event, Message } from "../../../src/engine/messages/messages";
const name = "custody: at outcome the session's live leases equal outcome.artifacts";
test(name, async () => {
  const start = performance.now(); let runs = 0;
  for (let count = 1; count <= 4; count++) {
    const scenarios = [
      { mode: "complete", target: -1, offset: 0 },
      ...Array.from({ length: count }, (_, target) => [
        ...Array.from({ length: 13 }, (_, offset) => ({ mode: "stop", target, offset })),
        ...["failure", "refuse", "invalid", "shutdown"].map(mode => ({ mode, target, offset: 0 })),
      ]).flat(),
    ];
    for (const { mode, target, offset } of scenarios) {
      runs++;
      const clock = new FakeClock(), backend = new ScriptedBackend(clock), port = new Map<string, Uint8Array>();
      const store = createArtifactStore(port, 1), events: Event[] = [];
      const planner: ReadPlanner = { plan(_req, _limits, identity) {
        const words = Array.from({ length: count }, (_, index) => ({ index, text: "Moss", display: [0, 4] satisfies [number, number] }));
        return { plan: { ...identity, type: "plan", display_document: { version: 1, text: "Moss", speech_start: 0, blocks: [] }, words,
          engine: { family: "edge", voice: "synthetic", profile_revision: "1" },
          pieces: words.map((_, index) => ({ piece_id: `p-${index}`, index, word_start: index, word_end: index + 1, raw: false,
            segments: [{ word_start: index, word_end: index + 1, kind: "sentence", pause_after_ms: 0, pause_in: "this_piece_end" }] })) },
          requests: words.map((_, piece_index) => ({ piece_index, text: "Moss" })) };
      } };
      const stop = () => session.send({ protocol: "nl.engine/1", type: "control", command_id: "custody-stop", session_id: "session-1-1", op: "stop", args: { scope: "session", reason: "stop" } });
      const publication = createPublication({ ...store, async put(...args) {
        const stored = await store.put(...args);
        if (args[1].piece_id === `p-${target}` && (mode === "stop" || mode === "shutdown")) {
          const interrupt = (remaining: number) => queueMicrotask(() => {
            if (remaining) interrupt(remaining - 1);
            else if (mode === "shutdown") void session.shutdown(100); else stop();
          });
          interrupt(offset);
        }
        return stored;
      } });
      const piece = publication.piece;
      publication.piece = async (...args) => {
        const receipt = await piece(...args);
        if (receipt.index === target && mode === "refuse") receipt.known_ms = -1;
        if (receipt.index === target && mode === "invalid") receipt.piece_id = "unplanned";
        return receipt;
      };
      backend.script(Array.from({ length: count }, (_, index) => ({ latency_ms: 1, late_after_cancel: false,
        result: mode === "failure" && index === target ? { kind: "error", code: "synthetic" } : { kind: "audio", ...pcmAudio(24) } })));
      const session = createEngineSession({ welcome: { package_version: "0.0.0-test", protocol_minor: 0, caps: ["lifecycle"], engines: [] }, owner_epoch: 1, clock, backend, planner, publication,
        limits: { max_chars: { read: 1000, speak: 1000, ask_prompt: 1000 }, lookahead: 4, aligner_reap_ms: 50 },
        observe: { event(event) { events.push(event); } } });
      session.send(hello); void session.events[Symbol.asyncIterator]().next(); expect(events.pop()?.type).toBe("welcome");
      session.send({ protocol: "nl.engine/1", type: "narrate", request_id: "custody-request", idempotency_key: "custody-key", use: "read",
        input: { text: "Moss", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" });
      for (let tick = 0; tick < 40; tick++) await clock.advance(1);
      for (const edge of ["spawned", "exited"] as const) session.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: "session-1-1",
        player_instance_id: "custody-player", control_epoch: 1, piece_index: count - 1, edge, t_mono_ms: clock.monotonic(),
        ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: count } } : {}) });
      await session.shutdown(100);
      for (let tick = 0; tick < 16; tick++) await Promise.resolve();
      const outcomes = events.filter((e): e is Message<"outcome"> => e.type === "outcome");
      expect(outcomes).toHaveLength(1);
      const artifacts = outcomes[0].artifacts, leases = store.leases("session-1-1");
      expect(leases.map(l => l.lease_id).sort()).toEqual(artifacts.map(a => a.lease_id).sort());
      expect([...port.keys()].sort()).toEqual(leases.map(l => l.handle).sort());
      expect(events.filter(e => e.type === "piece_ready").map(e => e.artifact.lease_id).sort()).toEqual(artifacts.map(a => a.lease_id).sort());
      for (const l of leases) expect(store.resolve(l.handle, l.lease_id).kind).toBe("resolved");
    }
  }
  console.log(`custody: ${runs} runs, 0 orphans, ${(performance.now() - start).toFixed(1)} ms`);
});

test("custody: release offsets preserve exactly the remaining delivered leases", async () => {
  for (let offset = 0; offset < 12; offset++) {
    const clock = new FakeClock(), backend = new ScriptedBackend(clock), port = new Map<string, Uint8Array>();
    const store = createArtifactStore(port, 1), events: Event[] = [], released = new Set<string>();
    const { createEngine } = await import("../../../src/engine/core/engine");
    backend.script(Array.from({ length: 6 }, () => ({ latency_ms: 2, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(24) } })));
    const session = createEngine({ clock, backend, artifacts: store, owner_epoch: 1, package_version: "0.0.0-test",
      limits: { max_chars: { read: 1000, speak: 1000, ask_prompt: 1000 }, lookahead: 3, aligner_reap_ms: 50 },
      engines: [{ family: "edge", max_chars: 40, legacy: false, clone: false, timing: "none", cancel: "abort_only", available: true }],
      chooseEngine: () => ({ family: "edge", voice: "synthetic", profile_revision: "1" }) });
    const collect = (async () => { for await (const e of session.events) events.push(e); })();
    const give = async (lease_id: string) => { session.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id }); for (let i = 0; i < 16; i++) await Promise.resolve(); released.add(lease_id); };
    session.send(hello);
    for (const id of ["custody-one", "custody-two"]) session.send({ protocol: "nl.engine/1", type: "narrate", request_id: id, idempotency_key: id, use: "read", input: { text: "Amber rafts float. Violet cranes glide. Golden otters swim.", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", lookahead: 3 });
    for (let tick = 0; tick < 20; tick++) {
      await clock.advance(1); for (let i = 0; i < 32; i++) await Promise.resolve();
      const pieces = events.filter(e => e.type === "piece_ready");
      if (tick === offset && pieces.length) { await give(pieces[0].artifact.lease_id); await give(pieces[0].artifact.lease_id); }
    }
    const pieces = events.filter(e => e.type === "piece_ready"); expect(pieces).toHaveLength(6);
    for (const p of pieces) for (const edge of ["spawned", "first_sample", "exited"] as const) session.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: p.session_id, player_instance_id: `custody-${p.index}`, control_epoch: p.index + 1, piece_index: p.index, edge, t_mono_ms: clock.monotonic(), ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: p.start_ms + p.duration_ms } } : {}) });
    for (let i = 0; i < 32; i++) await Promise.resolve();
    const outcomes = events.filter(e => e.type === "outcome"); expect(outcomes).toHaveLength(2);
    for (const o of outcomes) expect(o.artifacts.map(a => a.lease_id)).toEqual(pieces.filter(p => p.session_id === o.session_id && !released.has(p.artifact.lease_id)).map(p => p.artifact.lease_id));
    const after = pieces[4]; await give(after.artifact.lease_id); await give(after.artifact.lease_id);
    for (const o of outcomes) expect(store.leases(o.session_id).map(l => l.lease_id)).toEqual(o.artifacts.filter(a => a.lease_id !== after.artifact.lease_id).map(a => a.lease_id));
    expect([...port.keys()].sort()).toEqual(pieces.filter(p => !released.has(p.artifact.lease_id)).map(p => p.artifact.handle).sort());
    await session.shutdown(0); await collect; backend.assertDrained();
  }
});

test("release: a throwing delete retains the lease and emits nothing inside send", async () => {
  const clock = new FakeClock(), backend = new ScriptedBackend(clock), bytes = new Map<string, Uint8Array>();
  let fail = true, deletes = 0;
  const store = createArtifactStore({ has: h => bytes.has(h), get: h => bytes.get(h), set: (h, b) => bytes.set(h, b), delete(h) { deletes++; if (fail) throw Error("invented"); return bytes.delete(h); } }, 1);
  const { createEngine } = await import("../../../src/engine/core/engine");
  const c = createEngine({ clock, backend, artifacts: store, owner_epoch: 1, package_version: "0.0.0-test", limits: { max_chars: { read: 100, speak: 100, ask_prompt: 100 }, lookahead: 1, aligner_reap_ms: 50 }, engines: [], chooseEngine() { throw Error("unused"); } });
  const stored = await store.put(new Uint8Array([1, 2]), { owner_epoch: 1, session_id: "synthetic", attempt_id: "attempt", piece_id: "p" }, new AbortController().signal);
  const events: Event[] = [], collect = (async () => { for await (const e of c.events) events.push(e); })();
  c.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: stored.lease_id });
  c.send(hello); for (let i = 0; i < 16; i++) await Promise.resolve();
  expect(events.map(e => e.type)).toEqual(["error", "welcome"]); expect(events[0]).toMatchObject({ code: "NOT_NEGOTIATED" });
  c.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: stored.lease_id }); expect(deletes).toBe(0);
  for (let i = 0; i < 16; i++) await Promise.resolve();
  expect(events).toHaveLength(2); expect(c.resolve(stored.handle, stored.lease_id)).toEqual({ kind: "resolved", bytes: new Uint8Array([1, 2]) });
  fail = false; c.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: stored.lease_id });
  for (let i = 0; i < 16; i++) await Promise.resolve();
  expect(c.resolve(stored.handle, stored.lease_id)).toEqual({ kind: "expired" }); await c.shutdown(0); await collect;
});

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

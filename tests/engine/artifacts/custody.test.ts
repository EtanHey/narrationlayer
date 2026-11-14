import { createEngine } from "../../../src/engine/core/engine";
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
        ...Array.from({ length: 13 }, (_, offset) => ["stop", "shutdown"].map(mode => ({ mode, target, offset }))).flat(),
        ...["failure", "refuse", "invalid"].map(mode => ({ mode, target, offset: 0 })),
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
  for (const end of ["completed", "stop", "shutdown"]) for (let offset = 0; offset < 12; offset++) {
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
    for (const p of pieces) for (const edge of ["spawned", "first_sample", ...(p.index < 2 ? ["exited"] : [])]) session.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: p.session_id, player_instance_id: `custody-${p.index}`, control_epoch: p.index + 1, piece_index: p.index, edge, t_mono_ms: clock.monotonic(), ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: p.start_ms + p.duration_ms } } : {}) });
    for (let i = 0; i < 32; i++) await Promise.resolve();
    for (const last of pieces.filter(p => p.index === 2)) {
      const lease = pieces.find(p => p.session_id === last.session_id && p.index === 1)!.artifact.lease_id;
      session.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: lease }); released.add(lease);
      if (end === "stop") session.send({ protocol: "nl.engine/1", type: "control", command_id: "same-turn-stop", session_id: last.session_id, op: "stop", args: { scope: "session", reason: "stop" } });
      if (end === "completed") session.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: last.session_id, player_instance_id: `custody-${last.index}`, control_epoch: last.index + 1, piece_index: last.index, edge: "exited", t_mono_ms: clock.monotonic(), exit: { status: "completed", stopped_at_ms: last.start_ms + last.duration_ms } });
    }
    if (end === "shutdown") void session.shutdown(0);
    for (let i = 0; i < 32; i++) await Promise.resolve();
    const outcomes = events.filter(e => e.type === "outcome"); expect(outcomes).toHaveLength(2);
    for (const o of outcomes) expect(o.artifacts.map(a => a.lease_id)).toEqual(pieces.filter(p => p.session_id === o.session_id && !released.has(p.artifact.lease_id)).map(p => p.artifact.lease_id));
    const after = pieces[3]; if (end !== "shutdown") { await give(after.artifact.lease_id); await give(after.artifact.lease_id); }
    for (const o of outcomes) expect(store.leases(o.session_id).map(l => l.lease_id)).toEqual(o.artifacts.filter(a => end === "shutdown" || a.lease_id !== after.artifact.lease_id).map(a => a.lease_id));
    expect([...port.keys()].sort()).toEqual(pieces.filter(p => !released.has(p.artifact.lease_id)).map(p => p.artifact.handle).sort());
    await session.shutdown(0); await collect; backend.assertDrained();
  }
});

async function releaseFixture(failDelete = false, guess = false) {
  const clock = new FakeClock(), backend = new ScriptedBackend(clock), bytes = new Map<string, Uint8Array>();
  let deletes = 0;
  const store = createArtifactStore({ has: h => bytes.has(h), get: h => bytes.get(h), set: (h, b) => bytes.set(h, b), delete(h) { deletes++; if (failDelete) throw Error("invented"); return bytes.delete(h); } }, 1);
  const publication = createPublication({ ...store, async put(...args) {
    const stored = await store.put(...args);
    if (guess) session.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: stored.lease_id });
    return stored;
  } });
  const planner: ReadPlanner = { plan(_request, _limits, identity) {
    const words = ["Amber.", "Violet.", "Golden."].map((text, index) => ({ text, index, display: [0, 1] satisfies [number, number] }));
    return { plan: { ...identity, type: "plan", display_document: { version: 1, text: "Synthetic.", speech_start: 0, blocks: [] }, words, engine: { family: "edge", voice: "synthetic", profile_revision: "1" }, pieces: words.map((_, index) => ({ piece_id: `p-${index}`, index, word_start: index, word_end: index + 1, raw: false, segments: [{ word_start: index, word_end: index + 1, kind: "sentence", pause_after_ms: 0, pause_in: "this_piece_end" }] })) }, requests: words.map(w => ({ piece_index: w.index, text: w.text })) };
  } };
  backend.script(Array.from({ length: 3 }, () => ({ latency_ms: 1, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(24) } })));
  const session = createEngineSession({ owner_epoch: 1, clock, backend, planner, publication, artifacts: store, welcome: { package_version: "0.0.0-test", protocol_minor: 0, caps: ["lifecycle"], engines: [] }, limits: { max_chars: { read: 100, speak: 100, ask_prompt: 100 }, lookahead: 3, aligner_reap_ms: 50 } });
  const events: Event[] = [], collect = (async () => { for await (const e of session.events) events.push(e); })();
  session.send(hello); session.send({ protocol: "nl.engine/1", type: "narrate", request_id: "release-test", idempotency_key: "release-test", use: "read", input: { text: "Synthetic.", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" });
  for (let i = 0; i < 12; i++) { await clock.advance(1); for (let j = 0; j < 32; j++) await Promise.resolve(); }
  const pieces = events.filter(e => e.type === "piece_ready"); expect(pieces).toHaveLength(3);
  return { session, store, bytes, events, pieces, deletes: () => deletes, async finish() { await session.shutdown(0); await collect; backend.assertDrained(); } };
}
test("release: same-turn release then stop excludes the lease with zero synchronous deletes", async () => {
  const t = await releaseFixture();
  for (const p of t.pieces) for (const edge of ["spawned", "first_sample", ...(p.index < 2 ? ["exited"] : [])]) t.session.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: p.session_id, player_instance_id: `release-${p.index}`, control_epoch: p.index + 1, piece_index: p.index, edge, t_mono_ms: 0, ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: 24 } } : {}) });
  t.session.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: t.pieces[0].artifact.lease_id });
  expect(t.deletes()).toBe(0); expect(t.store.resolve(t.pieces[0].artifact.handle, t.pieces[0].artifact.lease_id).kind).toBe("expired");
  t.session.send({ protocol: "nl.engine/1", type: "control", command_id: "release-stop", session_id: t.pieces[0].session_id, op: "stop", args: { scope: "session", reason: "stop" } });
  for (let i = 0; i < 32; i++) await Promise.resolve();
  expect(t.deletes()).toBe(1); expect(t.events.filter(e => e.type === "outcome")[0].artifacts.map(a => a.lease_id)).toEqual(t.pieces.slice(1).map(p => p.artifact.lease_id)); await t.finish();
});
test("release: failed deferred delete keeps bytes pending but the lease expired", async () => {
  const t = await releaseFixture(true), p = t.pieces[0];
  t.session.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: p.artifact.lease_id });
  expect(t.deletes()).toBe(0); expect(t.store.resolve(p.artifact.handle, p.artifact.lease_id).kind).toBe("expired");
  for (let i = 0; i < 32; i++) await Promise.resolve();
  expect(t.deletes()).toBe(1); expect(t.bytes.has(p.artifact.handle)).toBe(true); expect(t.store.pendingDeletes()).toEqual([p.artifact.handle]);
  expect(t.events.filter(e => e.type === "error")).toEqual([]); await t.finish();
});
test("release: guessed minted lease at put offset zero is refused without deletion", async () => {
  const t = await releaseFixture(false, true);
  expect(t.deletes()).toBe(0); expect(t.bytes.size).toBe(3);
  expect(t.events.filter(e => e.type === "error").map(e => [e.code, e.phase, e.retry, e.details])).toEqual(t.pieces.map(p => ["ARTIFACT_EXPIRED", "retain", "never", { lease_id: p.artifact.lease_id }]));
  for (const p of t.pieces) expect(t.store.resolve(p.artifact.handle, p.artifact.lease_id).kind).toBe("resolved"); await t.finish();
});
test("release: a session without an artifact store refuses INVALID_REQUEST", async () => {
  // A throw-only session has no artifact store.
  const c = createEngineSession({ owner_epoch: 1, clock: new FakeClock(), backend: { async synthesizeRequest() { throw Error("unused"); } }, planner: { plan() { throw Error("unused"); } }, publication: { async piece() { throw Error("unused"); }, async commit() {} }, welcome: { package_version: "0.0.0-test", protocol_minor: 0, caps: ["lifecycle"], engines: [] }, limits: { max_chars: { read: 100, speak: 100, ask_prompt: 100 }, lookahead: 1, aligner_reap_ms: 50 } });
  const stream = c.events[Symbol.asyncIterator](); c.send(hello); await stream.next(); c.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: "lease:1:1" });
  expect((await stream.next()).value).toMatchObject({ type: "error", code: "INVALID_REQUEST" }); await c.shutdown(0);
});

test("shutdown: settlement leaves no unnamed lease at every publication offset", async () => {
  for (const mode of ["put", "stop", "release", "failure"]) for (let offset = 0; offset < 16; offset++) for (const deadline of [0, 100]) {
    const clock = new FakeClock(), store = createArtifactStore(new Map(), 1);
    const backend = new ScriptedBackend(clock); backend.script([{ latency_ms: 1, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(24) } }]);
    const { createEngine } = await import("../../../src/engine/core/engine");
    let shutdown: Promise<void> | undefined;
    const terminals: Message<"outcome">[] = [];
    const engine = createEngine({ clock, backend, observe: { event(e) { if (e.type === "outcome") terminals.push(e); } }, artifacts: { ...store, async put(...args) {
      const receipt = await store.put(...args);
      arm(receipt.lease_id);
      for (let i = 0; i < 8; i++) await Promise.resolve(); // Hold the stored receipt in flight.
      return receipt;
    } }, owner_epoch: 1, package_version: "0", limits: { max_chars: { read: 1000, speak: 1000, ask_prompt: 1000 }, lookahead: 3, aligner_reap_ms: 50 },
      engines: [{ family: "edge", max_chars: 120, legacy: false, clone: false, timing: "none", cancel: "abort_only", available: true }], chooseEngine: () => ({ family: "edge", voice: "synthetic", profile_revision: "1" }) });
    function arm(lease_id?: string) {
      let turns = offset;
      const interrupt = () => { if (turns--) queueMicrotask(interrupt); else {
        if (mode === "stop") engine.send({ protocol: "nl.engine/1", type: "control", command_id: "shutdown-stop", session_id: "session-1-1", op: "stop", args: { scope: "session", reason: "stop" } });
        if (mode === "release" && lease_id) engine.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id });
        shutdown = engine.shutdown(deadline).then(() => {
          if (deadline > 0) expect(store.leases("session-1-1").map(l => l.lease_id)).toEqual(terminals.flatMap(e => e.artifacts.map(a => a.lease_id)));
        });
      } };
      queueMicrotask(interrupt);
    }
    if (mode === "failure") backend.synthesizeRequest = () => { arm(); return Promise.reject(Error("synthetic failure")); };
    const events: Event[] = []; let ended = false;
    const collect = (async () => { for await (const event of engine.events) { expect(ended).toBe(false); events.push(event); } ended = true; })();
    engine.send(hello); engine.send({ protocol: "nl.engine/1", type: "narrate", request_id: "shutdown-offset", idempotency_key: "shutdown-offset", use: "read", input: { text: "Copper boats drift.", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" });
    await clock.advance(1); for (let i = 0; i < 128; i++) await Promise.resolve();
    expect(shutdown).toBeDefined(); await shutdown; await collect; expect(ended).toBe(true);
    const before = events.length; await clock.advance(50); expect(events.length).toBe(before);
  }
});

test("shutdown: pending deletes retry once outside the call and custody preserves named leases", async () => {
  const bytes = new Map<string, Uint8Array>(); let fail = true, deletes = 0;
  const store = createArtifactStore({ has: h => bytes.has(h), get: h => bytes.get(h), set: (h, b) => bytes.set(h, b), delete(h) { deletes++; if (fail) throw Error("synthetic storage refusal"); bytes.delete(h); } }, 1);
  const id = { owner_epoch: 1, session_id: "custody-session", attempt_id: "custody-attempt", piece_id: "custody-piece" }, signal = new AbortController().signal;
  const a = await store.put(new Uint8Array([1]), id, signal), b = await store.put(new Uint8Array([2]), id, signal);
  store.releaseFromHost(a.lease_id); for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(store.custody()).toEqual({ live: [{ lease_id: b.lease_id, handle: b.handle, session_id: id.session_id, piece_id: id.piece_id }], pending_delete: [a.handle] });
  fail = false; store.shutdown(); expect(deletes).toBe(1);
  await expect(store.put(new Uint8Array([3]), id, signal)).rejects.toMatchObject({ code: "shutdown" });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(deletes).toBe(2); expect(store.custody().pending_delete).toEqual([]); expect(store.resolve(b.handle, b.lease_id)).toEqual({ kind: "resolved", bytes: new Uint8Array([2]) });
  store.releaseFromHost(b.lease_id); expect(store.resolve(b.handle, b.lease_id).kind).toBe("expired");
  for (let i = 0; i < 8; i++) await Promise.resolve(); expect(bytes.size).toBe(0);
});

function shutdownEngine() {
  const clock = new FakeClock(), backend = new ScriptedBackend(clock), bytes = new Map<string, Uint8Array>(), events: Event[] = [];
  let failDelete = false;
  const store = createArtifactStore({ has: h => bytes.has(h), get: h => bytes.get(h), set: (h, b) => bytes.set(h, b), delete(h) { if (failDelete) throw Error("synthetic refusal"); return bytes.delete(h); } }, 1);
  const engine = createEngine({ clock, backend, artifacts: store, owner_epoch: 1, package_version: "0", observe: { event(e) { events.push(e); } },
    limits: { max_chars: { read: 1000, speak: 1000, ask_prompt: 1000 }, lookahead: 3, aligner_reap_ms: 50 }, engines: [{ family: "edge", max_chars: 120, legacy: false, clone: false, timing: "none", cancel: "abort_only", available: true }], chooseEngine: () => ({ family: "edge", voice: "synthetic", profile_revision: "1" }) });
  engine.send(hello);
  const read = (id: string) => engine.send({ protocol: "nl.engine/1", type: "narrate", request_id: id, idempotency_key: id, use: "read", input: { text: "Copper boats drift.", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" });
  return { engine, clock, backend, bytes, events, read, failDelete(value: boolean) { failDelete = value; } };
}
const microtasks = async () => { for (let i = 0; i < 128; i++) await Promise.resolve(); };
test("shutdown: engine custody pins live and pending handles through every release", async () => {
  for (const fail of [false, true]) {
    const t = shutdownEngine(); t.backend.script([{ latency_ms: 1, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(24) } }]);
    t.read("engine-custody"); await t.clock.advance(1); await microtasks();
    const pieces = t.events.filter(e => e.type === "piece_ready"); expect(pieces).toHaveLength(1);
    const live = pieces.map(p => ({ lease_id: p.artifact.lease_id, handle: p.artifact.handle, session_id: p.session_id, piece_id: p.piece_id }));
    expect(t.engine.custody()).toEqual({ live, pending_delete: [] });
    await t.engine.shutdown(100); expect(t.engine.custody()).toEqual({ live, pending_delete: [] });
    expect(t.engine.custody().live.map(({ session_id, ...a }) => a)).toEqual(t.events.filter(e => e.type === "outcome").flatMap(e => e.artifacts));
    t.failDelete(fail); t.engine.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: live[0].lease_id }); await microtasks();
    expect(t.engine.custody()).toEqual({ live: [], pending_delete: fail ? [live[0].handle] : [] });
  }

});
test("shutdown: mixed settlement custody property keeps the deadline at every offset", async () => {
  for (let offset = 0; offset < 16; offset++) {
    const t = shutdownEngine(); let release!: () => void, calls = 0;
    t.backend.synthesizeRequest = (_request, signal) => new Promise((resolve, reject) => {
      if (++calls === 1) signal.addEventListener("abort", () => reject(Error("synthetic abort")), { once: true });
      else release = () => resolve(pcmAudio(24));
    });
    t.read("mixed-settles"); t.read("mixed-stuck");
    for (let i = 0; i < offset; i++) await Promise.resolve();
    let done = false; const pending = t.engine.shutdown(30).then(() => { done = true; }); await microtasks();
    expect(done).toBe(false); expect(t.events.filter(e => e.type === "outcome")).toHaveLength(2);
    await t.clock.advance(29); await microtasks(); expect(done).toBe(false);
    await t.clock.advance(1); await microtasks(); expect(done).toBe(true); await pending;
    expect(t.engine.custody()).toEqual({ live: [], pending_delete: [] }); release(); await microtasks();
  }
});
for (const deadline of [NaN, -Infinity]) test(`shutdown: deadline ${deadline} resolves immediately without rejection`, async () => {
  const t = shutdownEngine(); let release!: () => void;
  t.backend.synthesizeRequest = () => new Promise(resolve => { release = () => resolve(pcmAudio(24)); }); t.read("nonfinite-now");
  await expect(t.engine.shutdown(deadline)).resolves.toBeUndefined(); expect(t.clock.now()).toBe(0); release(); await microtasks();
});
test("shutdown: positive Infinity schedules no timer and waits for settlement", async () => {
  const t = shutdownEngine(); let release!: () => void, scheduled = 0;
  t.backend.synthesizeRequest = () => new Promise(resolve => { release = () => resolve(pcmAudio(24)); }); t.read("nonfinite-wait");
  t.clock.schedule = () => { scheduled++; throw Error("unexpected timer"); };
  let done = false; const pending = t.engine.shutdown(Infinity).then(() => { done = true; }); await microtasks();
  expect(done).toBe(false); expect(scheduled).toBe(0); release(); await pending; expect(done).toBe(true);
});

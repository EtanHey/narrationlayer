import { expect, test } from "bun:test";
import engine from "../../../src/engine/conformance/engine-binding";
import { FakeClock } from "../../../src/engine/conformance/clock";
import { ScriptedBackend } from "../../../src/engine/conformance/fake-backend";
import { ScriptedPlayer, ScriptedSpawn } from "../../../src/engine/conformance/fake-player";
import { ScriptedHost } from "../../../src/engine/conformance/host-stub";
import { hello, engineCases } from "../../../src/engine/conformance/engine-cases";
import { runCase } from "../../../src/engine/conformance/runner";
import { parseEvent } from "../../../src/engine/messages/parser";
import type { Event, Message } from "../../../src/engine/messages/messages";
// §6 L359-361, Q94-98: exercise the composed engine, backend and publication.
for (const id of ["ENG-01", "ENG-02", "ENG-03"]) test(`synthesis fallback: ${id}`, async () => {
  expect((await runCase(id, engine, engineCases[id])).result).toBe("pass");
});
for (const absent of [false, true]) for (const clone of [false, true]) test(`Q96 unavailable ${clone ? "clone" : "stock"}, absent ${absent}`, async () => {
  const clock = new FakeClock(), backend = new ScriptedBackend(clock), spawn = new ScriptedSpawn(clock);
  const caps: Message<"welcome">["engines"] = absent ? [] : [{ family: clone ? "qwen3_clone" : "edge", available: false, legacy: false, clone, timing: "none", cancel: "abort_only" }];
  const c = engine.create({ clock, store: new Map(), hash_key: new Uint8Array(32), audible: false, engines: caps,
    voices: { profiles: { lantern: clone ? { kind: "clone", revision: "one" } : { kind: "preset", revision: "one", voice: "stock" } }, default_voice: "stock", hebrew_voice: "he-IL-HilaNeural" },
    ports: { backend, spawn, player: new ScriptedPlayer(clock, spawn), host: new ScriptedHost(clock) } });
  const seen: Event[] = [];
  const collect = (async () => { for await (const e of c.events) { const parsed = parseEvent(e); if (parsed.ok && parsed.value) seen.push(parsed.value); } })();
  c.send(hello); c.send({ protocol: "nl.engine/1", type: "narrate", request_id: "availability", idempotency_key: "availability", use: "read", input: { text: "Silver boats return.", format: "plain" }, voice: { profile: "lantern", require_clone: false, fallback: "none" }, delivery: "pieces" });
  for (let i = 0; i < 64 && !seen.some(e => e.type === (absent ? "error" : "outcome")); i++) { await clock.advance(1); for (let j = 0; j < 128; j++) await Promise.resolve(); }
  expect(seen.filter(e => e.type === "error")).toMatchObject([absent ? { code: "INVALID_REQUEST", phase: "admit" } : { code: "ENGINE_UNAVAILABLE", phase: "synthesize", retry: "new_request" }]); // Q96
  expect(seen.filter(e => e.type === "outcome")).toMatchObject(absent ? [] : [{ generation: { status: "failed" } }]);
  expect(backend.calls).toEqual([]); // Q96: availability is checked before calling.
  await c.shutdown(clock.now()); await collect; backend.assertDrained();
});

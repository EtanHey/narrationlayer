import { expect, test } from "bun:test";
import { createEngine } from "../../src/engine/core/engine";
import binding from "../../src/engine/conformance/engine-binding";
import { ScriptedPlayer, ScriptedSpawn } from "../../src/engine/conformance/fake-player";
import { ScriptedHost } from "../../src/engine/conformance/host-stub";
import { FakeClock } from "../../src/engine/conformance/clock";
import { hello } from "../../src/engine/conformance/engine-cases";
import { pcmAudio, ScriptedBackend } from "../../src/engine/conformance/fake-backend";
import { createArtifactStore } from "../../src/engine/artifacts/store";
import type { Event } from "../../src/engine/messages/messages";

const sentence = ["Ambers " + "Amber ".repeat(15) + "go,", ...Array<string>(3).fill("Amber ".repeat(16) + "go,")].join(" ").replace(/,$/, ".");
async function run(text: string, mode: "binding" | "uncapped" | "unknown" = "binding") {
  const clock = new FakeClock(), backend = new ScriptedBackend(clock);
  backend.script(Array.from({ length: mode === "unknown" || text.length > 1000 ? 0 : mode === "uncapped" ? 1 : 4 },
    () => ({ latency_ms: 0, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(1) } })));
  const c = mode === "binding"
    ? binding.create({ clock, store: new Map(), hash_key: new Uint8Array(32), audible: false, ports: { backend, spawn: new ScriptedSpawn(clock), player: new ScriptedPlayer(clock, new ScriptedSpawn(clock)), host: new ScriptedHost(clock) } })
    : createEngine({ clock, backend, owner_epoch: 1, package_version: "synthetic",
      limits: { max_chars: { read: 1000, speak: 1000, ask_prompt: 1000 }, lookahead: 10, aligner_reap_ms: 50 },
      engines: [...(mode === "unknown" ? [] : [{ family: "edge" as const, legacy: false, clone: false, timing: "none", cancel: "abort_only", available: true } as const]),
        { family: "xtts", max_chars: 1, legacy: false, clone: false, timing: "none", cancel: "abort_only", available: true }],
      voices: { profiles: { synthetic: { kind: "preset", revision: "synthetic", voice: "synthetic" } }, default_voice: "synthetic", hebrew_voice: "he-IL-HilaNeural" },
      artifacts: createArtifactStore(new Map(), 1) });
  const events: Event[] = [], collect = (async () => { for await (const event of c.events) events.push(event); })();
  try {
    c.send(hello);
    c.send({ protocol: "nl.engine/1", type: "narrate", request_id: "request-cap", idempotency_key: "key-cap", use: "read",
      input: { text, format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", lookahead: 10 });
    for (let i = 0; i < 10; i++) { await clock.advance(0); for (let j = 0; j < 128; j++) await Promise.resolve(); }
  } finally { await c.shutdown(0); await collect; }
  backend.assertDrained();
  const requests = backend.calls.map(call => {
    if (!call || typeof call !== "object" || Array.isArray(call) || typeof call.text !== "string") throw new Error("missing backend text");
    return call.text;
  });
  return { events, requests, plan: events.find(event => event.type === "plan") };
}

test("sentence cap: the serving engine's max_chars cuts an over-limit sentence the input limit admits", async () => {
  const { events, plan, requests } = await run(sentence);
  expect(sentence.length).toBe(400);
  expect(events[0]).toMatchObject({ type: "welcome", limits: { max_chars: { read: 1000 } }, engines: [expect.objectContaining({ max_chars: 120 })] });
  expect(plan?.pieces).toHaveLength(4);
  expect(events.some(event => event.type === "accepted")).toBe(true);
  expect(requests).toHaveLength(4);
  expect(requests.join(" ")).toBe(sentence);
  expect(requests.every(text => text.length <= 120)).toBe(true);
  expect(requests.slice(0, -1).every(text => /[,;:]$/.test(text))).toBe(true);
  expect(plan?.pieces.slice(0, -1).every(piece => piece.segments.every(segment => segment.pause_after_ms === 0))).toBe(true);
});

test("sentence cap: an engine without max_chars never cuts", async () => {
  const text = "Amber ".repeat(149) + "drift.";
  const { plan, requests } = await run(text, "uncapped");
  expect(text.length).toBe(900); expect(plan?.pieces).toHaveLength(1); expect(requests).toEqual([text]);
});

test("sentence cap: the input limit is not the cutter's cap", async () => {
  const tooLong = "Amber ".repeat(166) + "goes.";
  expect(tooLong.length).toBe(1001);
  const admitted = await run(sentence), refused = await run(tooLong);
  expect(admitted.plan?.pieces).toHaveLength(4);
  expect(refused.events).toContainEqual(expect.objectContaining({ type: "error", code: "INPUT_TOO_LONG" }));
  expect(refused.plan).toBeUndefined(); expect(refused.requests).toEqual([]);
});

test("sentence cap: an unknown selected family is refused as INVALID_REQUEST", async () => {
  const { events, plan, requests } = await run("Amber boats drift.", "unknown");
  expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "INVALID_REQUEST", request_id: "request-cap" }));
  expect(plan).toBeUndefined(); expect(requests).toEqual([]);
});

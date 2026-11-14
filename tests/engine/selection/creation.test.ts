import { expect, test } from "bun:test";
import binding from "../../../src/engine/conformance/engine-binding";
import { createEngine } from "../../../src/engine/core/engine";
import { createArtifactStore } from "../../../src/engine/artifacts/store";
import { FakeClock } from "../../../src/engine/conformance/clock";
import { hello } from "../../../src/engine/conformance/engine-cases";
import { pcmAudio } from "../../../src/engine/conformance/fake-backend";
import type { Message } from "../../../src/engine/messages/messages";
const table = { profiles: { lantern: { kind: "clone", revision: "c1" } }, default_voice: "en-US-AriaNeural", hebrew_voice: "he-IL-HilaNeural" } satisfies Parameters<typeof createEngine>[0]["voices"];
for (const [name, voices] of [
  ["nonobject profile", { ...table, profiles: { lantern: null } }],
  ["unknown kind", { ...table, profiles: { lantern: { kind: "other", revision: "c1" } } }],
  ["missing revision", { ...table, profiles: { lantern: { kind: "clone" } } }],
  ["missing preset voice", { ...table, profiles: { lantern: { kind: "preset", revision: "p1" } } }],
  ["empty default", { ...table, default_voice: "" }],
  ["empty Hebrew", { ...table, hebrew_voice: "" }],
  ["nonobject profiles", { ...table, profiles: null }],
] as const) test(`creation rejects ${name}`, () => {
  expect(() => binding.create({ voices: JSON.parse(JSON.stringify(voices)), clock: new FakeClock(), store: new Map(), hash_key: new Uint8Array(32), audible: false })).toThrow();
});
test("announce counts collapsed spaces and trimmed ends, preserving interior tabs and newlines", async () => {
  for (const [text, family] of [["a".repeat(48) + ".\n", "edge"], ["a".repeat(47) + "  b", "edge"], ["a".repeat(48) + "  b", "qwen3_clone"], ["a".repeat(47) + "\t\tb", "qwen3_clone"], ["a".repeat(47) + "\n\nb", "qwen3_clone"]]) {
    const clock = new FakeClock(); let plan: Message<"plan"> | undefined;
    const engine = createEngine({ synthesis_timeout_ms: 10000, clock, voices: table, engines: [{ family: "edge", available: true, legacy: false, clone: false, timing: "none", cancel: "abort_only" }, { family: "qwen3_clone", available: true, legacy: false, clone: true, timing: "none", cancel: "abort_only" }], owner_epoch: 1, package_version: "synthetic", limits: { max_chars: { read: 1000, speak: 1000, ask_prompt: 1000 }, lookahead: 2, aligner_reap_ms: 50 }, artifacts: createArtifactStore(new Map(), 1), backend: { async synthesizeRequest() { return { bytes: pcmAudio(100).bytes, timings: null }; } }, observe: { event(e) { if (e.type === "plan") plan = e; } } });
    engine.send(hello); engine.send({ protocol: "nl.engine/1", type: "narrate", request_id: "count-request", idempotency_key: "count-key", use: "speak", mode: "announce", input: { text, format: "plain" }, voice: { profile: "lantern", require_clone: false, fallback: "none" }, delivery: "pieces" });
    expect(plan?.engine.family).toBe(family);
    await engine.shutdown(clock.now());
  }
});

// Ruling 90: hosts must choose a finite positive synthesis bound, including at runtime.
for (const bound of [undefined, 0, -1, NaN, Infinity]) test(`creation rejects synthesis bound ${bound}`, () => {
  expect(() => Reflect.apply(createEngine, undefined, [{ synthesis_timeout_ms: bound, clock: new FakeClock(), voices: table,
    engines: [], owner_epoch: 1, package_version: "synthetic", artifacts: createArtifactStore(new Map(), 1),
    limits: { max_chars: { read: 100, speak: 100, ask_prompt: 100 }, lookahead: 2, aligner_reap_ms: 50 },
    backend: { async synthesizeRequest() { return { bytes: pcmAudio(1).bytes, timings: null }; } },
  }])).toThrow("invalid synthesis_timeout_ms");
});

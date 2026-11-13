import { expect, test } from "bun:test";
import fixtures from "./fixtures.json";
import { negotiate, parseEvent, parseRequest } from "../../../src/engine/messages/parser";
const fixture = (name: string) => { const f = fixtures.find(f => f.name === name); if (!f) throw Error(name); return structuredClone(f.valid) as Record<string, unknown>; };
test("round1 MINOR-2/3/4 envelope, string priority and absent engine limit", () => {
  expect(parseEvent({ ...fixture("playback_started"), amplitude: { source: "synthetic", sample_interval_ms: 10, samples: [0.1] } }).ok).toBe(true);
  expect(parseEvent({ ...fixture("queue"), items: [{ session_id: "session-1", priority: "normal", is_current: true, progress: 0 }] }).ok).toBe(true);
  expect(parseEvent({ ...fixture("engine_status"), engines: [{ family: "qwen3_clone", legacy: false, clone: true, timing: "none", cancel: "abort_only", available: true }] }).ok).toBe(true);
});
test("round1 MINOR-5/6 audibility, absent undefined and ignored unknown values", () => {
  expect(parseRequest({ ...fixture("hello"), audible: true })).toMatchObject({ ok: false, error: { path: "$.audible" } });
  expect(parseRequest({ ...fixture("hello"), binding: "process", audible: true }).ok).toBe(true);
  const original = parseRequest(fixture("narrate"));
  for (const extras of [{ lookahead: undefined }, { x: Infinity }, { x: new Date() }]) expect(parseRequest({ ...fixture("narrate"), ...extras })).toEqual(original);
});
test("round1 MINOR-7 seek branch and ambiguity paths", () => {
  expect(parseRequest({ ...fixture("control-seek"), args: { audio_ms: "x" } })).toMatchObject({ ok: false, error: { path: "$.args.audio_ms" } });
  expect(parseRequest({ ...fixture("control-seek"), args: { audio_ms: 5, word_index: 9 } })).toMatchObject({ ok: false, error: { path: "$.args" } });
});
test("round1 NOTE-9 pre-welcome gate precedes message validation", () => {
  const welcome = parseEvent(fixture("welcome")); if (!welcome.ok || welcome.value?.type !== "welcome") throw Error("fixture");
  for (const value of [null, undefined, 7, [], {}, { type: "future" }, { type: "narrate", input: false }]) expect(negotiate(value, welcome.value)).toMatchObject({ ok: false, error: { code: "NOT_NEGOTIATED" } });
  expect(negotiate({ type: "hello" }, welcome.value)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
});
test("round1 hostile reviewer probes remain total", () => {
  const throwing = Object.defineProperty({}, "protocol", { get() { throw Error("synthetic"); } });
  let deep: unknown = null; for (let i = 0; i < 200_000; i++) deep = [deep];
  const objects = [throwing, new Proxy({}, { get() { throw Error("synthetic"); }, has() { throw Error("synthetic"); } }), Object.create(null), new (class Wire {})(), deep, NaN, Infinity, { ...fixture("hello"), protocol: "nl.engine/01" }, JSON.parse('{"protocol":"nl.engine/1","type":"future","__proto__":{"polluted":true}}')];
  for (const v of objects) expect(() => { parseRequest(v); parseEvent(v); parseEvent({ ...fixture("playback_started"), amplitude: deep }); }).not.toThrow();
  expect(Object.hasOwn({}, "polluted")).toBe(false);
  const limits = { max_chars: { read: 2, speak: 2, ask_prompt: 2 }, lookahead: 1, aligner_reap_ms: 1 };
  expect(parseRequest({ ...fixture("narrate"), input: { text: "😀", format: "plain" } }, limits).ok).toBe(true);
  expect(parseRequest({ ...fixture("narrate"), input: { text: "😀x", format: "plain" } }, limits)).toMatchObject({ ok: false, error: { code: "INPUT_TOO_LONG" } });
});

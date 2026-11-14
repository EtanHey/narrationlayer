import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fixtures from "./fixtures.json";
import { events, requests } from "../../../src/engine/messages/messages";
import { negotiate, parseEvent, parseRequest, requireNegotiated } from "../../../src/engine/messages/parser";
import { schemaFiles } from "./generate-schemas";
const receive = (direction: string, value: unknown) => direction === "event" ? parseEvent(value) : parseRequest(value);
for (const f of fixtures) {
  test(`fixture ${f.name}: valid, selected missing field, null rejection, extra fields`, () => {
    const parsed = receive(f.direction, f.valid);
    expect<unknown>(parsed).toEqual({ ok: true, value: f.valid });
    expect(structuredClone(parsed)).toEqual(parsed);
    expect(receive(f.direction, f.invalid).ok).toBe(false);
    expect(receive(f.direction, { ...f.valid, [f.missing]: null }).ok).toBe(false);
    expect(receive(f.direction, { ...f.valid, future_minor_field: { ignored: true } })).toEqual(parsed);
  });
}
test("fixtures cover every message, operation and lifecycle edge", () => {
  expect([...new Set(fixtures.map(f => f.valid.type))].sort()).toEqual([...Object.keys(requests), ...Object.keys(events)].sort());
  expect(fixtures.filter(f => f.name.startsWith("control-")).length).toBe(8);
  expect(fixtures.filter(f => f.name.startsWith("lifecycle-")).length).toBe(7);
});
const fixture = (name: string): Record<string, unknown> => { const f = fixtures.find(f => f.name === name); if (!f) throw Error(name); return structuredClone(f.valid); };
test("nested required fields retain offending paths", () => {
  const value = fixture("narrate"); value.input = { format: "plain" };
  expect(parseRequest(value)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", path: "$.input.text" } });
  value.input = { text: "Synthetic", format: 1 };
  expect(parseRequest(value)).toMatchObject({ ok: false, error: { path: "$.input.format" } });
});
test("NEG-01/02/03 pure negotiation and explicit session gate", () => {
  const welcome = parseEvent(fixture("welcome"));
  if (!welcome.ok || welcome.value?.type !== "welcome") throw Error("fixture");
  expect(negotiate(fixture("hello"), welcome.value)).toEqual({ ok: true, value: welcome.value });
  expect(negotiate({ ...fixture("hello"), protocol: "nl.engine/2" }, welcome.value)).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_VERSION" } });
  expect(negotiate({ ...fixture("hello"), required_caps: ["absent"] }, welcome.value)).toMatchObject({ ok: false, error: { code: "MISSING_CAPABILITY", path: "$.required_caps", details: { missing_caps: [], unknown_cap_indices: [0] } } });
  expect(negotiate(fixture("narrate"), welcome.value)).toMatchObject({ ok: false, error: { code: "NOT_NEGOTIATED" } });
  expect(requireNegotiated(false)).toMatchObject({ ok: false, error: { code: "NOT_NEGOTIATED" } }); expect(requireNegotiated(true)).toEqual({ ok: true, value: true });
});
test("VER-01/02 unknown type and major rules in both directions", () => {
  expect(parseEvent({ protocol: "nl.engine/1", type: "future" })).toEqual({ ok: true, value: null });
  for (const type of ["future", "toString", "__proto__"]) expect(parseRequest({ protocol: "nl.engine/1", type })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", path: "$.type" } });
  expect(parseEvent({ protocol: "nl.engine/2", type: "future" })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_VERSION" } });
});
test("LIM-01 each use accepts the boundary and refuses excess without truncation", () => {
  const limits = { max_chars: { read: 3, speak: 4, ask_prompt: 5 }, lookahead: 1, aligner_reap_ms: 500 };
  for (const use of ["read", "speak", "ask_prompt"] as const) {
    const value = { ...fixture("narrate"), use, mode: "brief", retain_artifact: true, input: { text: "x".repeat(limits.max_chars[use]), format: "plain" } };
    expect(parseRequest(value, limits).ok).toBe(true); value.input.text += "x";
    expect(parseRequest(value, limits)).toMatchObject({ ok: false, error: { code: "INPUT_TOO_LONG", path: "$.input.text" } });
  }
  expect(parseRequest({ ...fixture("narrate"), use: "speak" })).toMatchObject({ ok: false, error: { path: "$.mode" } });
  expect(parseRequest({ ...fixture("narrate"), use: "ask_prompt" })).toMatchObject({ ok: false, error: { path: "$.retain_artifact" } });
  expect(parseRequest({ ...fixture("hello"), audible: true }).ok).toBe(false);
});
test("fixed-seed malformed inputs never throw", () => {
  let seed = 0x51a; const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const bad = [null, undefined, NaN, Infinity, 7n, () => 0, Symbol("wire"), new Date(), [], false];
  for (let i = 0; i < 600; i++) { const f = fixtures[next() % fixtures.length]; const value = i % 2 ? bad[next() % bad.length] : { ...f.valid, [Object.keys(f.valid)[next() % Object.keys(f.valid).length]]: bad[next() % bad.length] }; expect(() => { parseRequest(value); parseEvent(value); }).not.toThrow(); }
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(() => { parseRequest(cyclic); parseEvent(cyclic); }).not.toThrow();
});
test("schema files and frozen snapshot match the runtime definitions", () => {
  for (const { family, text: generated } of schemaFiles()) {
    const text = readFileSync(new URL(`../../../src/engine/messages/${family}.schema.json`, import.meta.url), "utf8");
    expect(text).toBe(generated);
    expect(createHash("sha256").update(text).digest("hex")).toBe(readFileSync(new URL(`./${family}.sha256`, import.meta.url), "utf8").trim());
  }
});

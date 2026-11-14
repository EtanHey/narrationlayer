import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decodePcm, AudioDecodeError } from "../../src/engine/publication/decoded";
import { startMs, wordTimes } from "../../src/engine/publication/time";
import { createPublication } from "../../src/engine/publication/publication";
import { createEngineSession, type ReadPlanner } from "../../src/engine/session/session";
import { pcmAudio, ScriptedBackend } from "../../src/engine/conformance/fake-backend";
import { FakeClock } from "../../src/engine/conformance/clock";
import { parseEvent } from "../../src/engine/messages/parser";
import type { Event, Message } from "../../src/engine/messages/messages";
const words = ["Copper", "boats", "drift"].map((text, index) => ({ text, index, display: [index * 8, index * 8 + text.length] as [number, number] }));
const timeName = "TIME-01: start_ms equals cumulative decoded samples, rounded once";
test(timeName, () => {
  const prefix = Array.from({ length: 1000 }, () => ({ sample_count: 1, sample_rate: 24000 }));
  expect(startMs(prefix)).toBe(42); expect(prefix.reduce((n, p) => n + startMs([p]), 0)).toBe(0);
  expect(startMs([{ sample_count: 1, sample_rate: 2000 }])).toBe(1);
  expect(startMs([{ sample_count: 1, sample_rate: 3000 }, { sample_count: 1, sample_rate: 6000 }])).toBe(1);
  expect(startMs([{ sample_count: 12, sample_rate: 24000 }, { sample_count: 12, sample_rate: 24000 }]) - startMs([{ sample_count: 12, sample_rate: 24000 }])).toBe(0); // each duration rounds to 1
  expect(() => startMs([{ sample_count: 1, sample_rate: 0 }])).toThrow();
});
test("WORD-02: an engine with no timings: every word numeric and estimated", () => {
  expect(wordTimes(words, 20, 10, null)).toEqual(words.map((w, i) => ({ index: w.index, start_ms: 20 + Math.round(10 * i / 3), end_ms: 20 + Math.round(10 * (i + 1) / 3), timing: "estimated" })));
  expect(wordTimes(words, 0, 0, null).every(w => w.start_ms === 0 && w.end_ms === 0)).toBe(true);
});
test("measured timings: mapped in order; count, order, range or invalid entry falls back whole", () => {
  const entries = words.map((w, i) => ({ text: w.text, offset_ms: i * 10, duration_ms: 10 }));
  expect(wordTimes(words, 50, 30, { words: entries })).toEqual(words.map((w, i) => ({ index: w.index, start_ms: 50 + i * 10, end_ms: 60 + i * 10, timing: "measured" })));
  for (const raw of [entries.slice(1), [...entries].reverse(), [...entries, null], entries.map(t => ({ ...t, duration_ms: 100 })), entries.map(t => ({ ...t, index: 9 }))])
    expect(wordTimes(words, 50, 30, { words: raw }).every(w => w.timing === "estimated")).toBe(true);
});
function wav(bits: number, channels: number, odd = false) {
  const size = channels * bits / 8 * 4, extra = odd ? 10 : 0, bytes = new Uint8Array(44 + extra + size), v = new DataView(bytes.buffer);
  const tag = (p: number, s: string) => [...s].forEach((c, i) => v.setUint8(p + i, c.charCodeAt(0)));
  tag(0, "RIFF"); v.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, 24000, true); v.setUint32(28, 24000 * channels * bits / 8, true);
  v.setUint16(32, channels * bits / 8, true); v.setUint16(34, bits, true);
  if (odd) { tag(36, "JUNK"); v.setUint32(40, 1, true); }
  tag(36 + extra, "data"); v.setUint32(40 + extra, size, true); return bytes;
}
test("decoder: PCM widths, multiple channels, subarray and odd chunk padding", () => {
  for (const bits of [8, 16, 24, 32]) for (const channels of [1, 2, 5]) for (const odd of [false, true])
    expect(decodePcm(wav(bits, channels, odd))).toEqual({ sample_count: 4, sample_rate: 24000, channels });
  const b = wav(16, 2), wrapped = new Uint8Array(b.length + 7); wrapped.set(b, 3);
  expect(decodePcm(wrapped.subarray(3, 3 + b.length)).sample_count).toBe(4);
  expect(decodePcm(pcmAudio(0).bytes).sample_count).toBe(0);
});
test("decoder: refuses unsupported, truncated data, malformed headers, partial frames and missing chunks", () => {
  const cases = [new Uint8Array(), wav(16, 1).slice(0, -1)];
  for (const [at, value, width] of [[0, 0, 2], [8, 0, 2], [20, 3, 2], [22, 0, 2], [24, 0, 4], [28, 0, 4], [32, 9, 2], [34, 12, 2], [40, 1000, 4], [40, 7, 4], [36, 0, 4]] as const) {
    const b = wav(16, 1), v = new DataView(b.buffer); if (width === 2) v.setUint16(at, value, true); else v.setUint32(at, value, true); cases.push(b);
  }
  for (const b of cases) expect(() => decodePcm(b)).toThrow(AudioDecodeError);
});
test("decoder: reordered data, extended fmt, duplicate chunks, incomplete headers and absent padding", () => {
  const original = wav(16, 1);
  function chunks(parts: Uint8Array[]) {
    const b = new Uint8Array(12 + parts.reduce((n, p) => n + p.length, 0)); b.set(original.subarray(0, 12));
    let at = 12; for (const p of parts) { b.set(p, at); at += p.length; } new DataView(b.buffer).setUint32(4, b.length - 8, true); return b;
  }
  const fmt = original.slice(12, 36), data = original.slice(36);
  expect(decodePcm(chunks([data, fmt])).sample_count).toBe(4);
  const extended = new Uint8Array(26); extended.set(fmt); new DataView(extended.buffer).setUint32(4, 18, true);
  expect(decodePcm(chunks([extended, data])).sample_count).toBe(4);
  for (const b of [chunks([fmt, fmt, data]), chunks([fmt, data, data]), chunks([data]), chunks([fmt]), chunks([fmt, new Uint8Array(3)])])
    expect(() => decodePcm(b)).toThrow(AudioDecodeError);
  const odd = new Uint8Array(9); odd.set([74, 85, 78, 75, 1, 0, 0, 0, 0]);
  expect(() => decodePcm(chunks([fmt, data, odd]))).toThrow(AudioDecodeError);
});
const planner: ReadPlanner = { plan(req, _limits, id) { return { plan: { ...id, type: "plan", display_document: { version: 1, text: "Copper boats drift", speech_start: 0, blocks: [] }, words,
  engine: { family: "synthetic", voice: "synthetic", profile_revision: "1" }, pieces: words.map((_, index) => ({ index, piece_id: `piece-${index}`, word_start: index, word_end: index + 1, raw: false, segments: [{ word_start: index, word_end: index + 1, kind: "sentence", pause_after_ms: 0, pause_in: "this_piece_end" }] })) }, requests: words.map((w, piece_index) => ({ piece_index, text: w.text })) }; } };
async function read(lengths: number[], lie = 1) {
  const clock = new FakeClock(), backend = new ScriptedBackend(clock), events: Event[] = [], store = new Map<string, Uint8Array>();
  const publication = createPublication({ async put(bytes) { const handle = `artifact-${store.size}`; store.set(handle, bytes); return { handle, lease_id: handle, format: "wav" }; }, async commit() {} });
  const publish = publication.piece;
  publication.piece = (audio, context, signal) => {
    expect(context.words).toEqual([words[context.index]]);
    return publish(audio, context, signal);
  };
  backend.script(lengths.map(n => ({ latency_ms: 1, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(n, 24000, n * 1000 / 24000 * lie) } })));
  const session = createEngineSession({ owner_epoch: 1, limits: { max_chars: { read: 1000, speak: 1000, ask_prompt: 1000 }, lookahead: 3, aligner_reap_ms: 100 }, planner, backend, clock, publication, observe: { event(e) { events.push(e); } } });
  session.send({ protocol: "nl.engine/1", type: "narrate", request_id: "synthetic-request", idempotency_key: "synthetic-key", use: "read", input: { text: "Copper boats drift", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" });
  for (let i = 0; i < 40; i++) await clock.advance(1);
  await session.shutdown(100); backend.assertDrained();
  for (const event of events) expect(parseEvent(event).ok).toBe(true);
  const pieces = events.filter((e): e is Message<"piece_ready"> => e.type === "piece_ready"); expect(pieces).toHaveLength(3);
  for (const [i, p] of pieces.entries()) {
    expect(p.start_ms).toBe(startMs(lengths.slice(0, i).map(sample_count => ({ sample_count, sample_rate: 24000 }))));
    expect(p.duration_ms).toBe(Math.round(lengths[i] * 1000 / 24000)); expect(p.artifact.sample_count).toBe(lengths[i]); expect(p.artifact.sample_rate).toBe(24000);
    expect(p.words).toEqual([{ index: i, start_ms: p.start_ms, end_ms: p.start_ms + p.duration_ms, timing: "estimated" }]);
    expect(p.artifact.sha256).toBe(createHash("sha256").update(store.get(p.artifact.handle)!).digest("hex"));
    expect(p.spoken_text).toBe(words[i].text); expect(p.synthesis_ms).toBe(1);
    expect(p.actual).toEqual([{ segment: 0, engine: "synthetic", voice: "synthetic", substituted: false }]);
  }
  return pieces.map(({ start_ms, duration_ms, words }) => ({ start_ms, duration_ms, words }));
}
test("TIME-02: a backend that reports three times the real length changes nothing", async () => { expect(await read([251, 251, 251], 3)).toEqual(await read([251, 251, 251])); });
test("DET-01: byte-identical requests returning different lengths: every time follows the returned audio", async () => { expect(await read([251, 251, 251])).not.toEqual(await read([500, 750, 1000])); });
test("every piece_ready parses; three-piece session starts follow decoded samples; piece 1 words are read-global", async () => { const p = await read([251, 251, 251]); expect(p.map(p => p.start_ms)).toEqual([0, 10, 21]); expect(p[1].words[0].start_ms).toBe(10); });
function encodedWav(bits: number, encoding = 1, extensible = false, riffUnknown = false, dataUnknown = false, pad = true) {
  const fmtSize = extensible ? 40 : 16, size = 101 * bits / 8, dataAt = 20 + fmtSize;
  const b = new Uint8Array(dataAt + 8 + size + (pad ? size % 2 : 0)), v = new DataView(b.buffer);
  b.set(new TextEncoder().encode("RIFF")); b.set(new TextEncoder().encode("WAVEfmt "), 8);
  v.setUint32(4, riffUnknown ? 0xFFFFFFFF : b.length - 8, true); v.setUint32(16, fmtSize, true);
  v.setUint16(20, extensible ? 0xFFFE : encoding, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true);
  v.setUint32(28, 24000 * bits / 8, true); v.setUint16(32, bits / 8, true); v.setUint16(34, bits, true);
  if (extensible) { v.setUint16(36, 22, true); v.setUint16(38, bits, true); v.setUint16(44, encoding, true); b.set([16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 50); }
  b.set(new TextEncoder().encode("data"), dataAt); v.setUint32(dataAt + 4, dataUnknown ? 0xFFFFFFFF : size, true); return b;
}
for (const [name, bytes] of [
  ["float32", encodedWav(32, 3)], ["float64", encodedWav(64, 3)],
  ["extensible16", encodedWav(16, 1, true)], ["extensible24", encodedWav(24, 1, true)],
  ["extensible-float32", encodedWav(32, 3, true)], ["extensible-float64", encodedWav(64, 3, true)],
  ["RIFF unknown", encodedWav(16, 1, false, true)], ["data unknown", encodedWav(16, 1, false, false, true)],
  ["both unknown", encodedWav(16, 1, false, true, true)],
  ["final data pad absent 8-bit", encodedWav(8, 1, false, false, false, false)],
  ["final data pad absent 24-bit", encodedWav(24, 1, false, false, false, false)],
] as const) test(`decoder round1 accepts ${name}`, () => { expect(decodePcm(bytes)).toEqual({ sample_count: 101, sample_rate: 24000, channels: 1 }); });
for (const kind of ["overrun", "two data", "partial frame", "non-ASCII id", "zero data with silent payload", "outside RIFF", "short extensible", "invalid subformat", "float16", "unknown non-data size"] as const)
  test(`decoder round1 refuses ${kind}`, () => {
    let b = encodedWav(16), v = new DataView(b.buffer);
    if (kind === "overrun") v.setUint32(40, 0xFFFFFFFE, true);
    if (kind === "two data") { const c = new Uint8Array(b.length + 8); c.set(b); c.set([100, 97, 116, 97], b.length); b = c; new DataView(b.buffer).setUint32(4, b.length - 8, true); }
    if (kind === "partial frame") { b = b.slice(0, -1); v = new DataView(b.buffer); v.setUint32(4, 0xFFFFFFFF, true); v.setUint32(40, 0xFFFFFFFF, true); }
    if (kind === "non-ASCII id") { const c = new Uint8Array(b.length + 8); c.set(b); c[b.length] = 0x80; b = c; new DataView(b.buffer).setUint32(4, b.length - 8, true); }
    if (kind === "zero data with silent payload") { b = b.slice(0, -2); v = new DataView(b.buffer); v.setUint32(4, b.length - 8, true); v.setUint32(40, 0, true); }
    if (kind === "outside RIFF") v.setUint32(4, b.length - 9, true);
    if (kind === "short extensible") v.setUint16(20, 0xFFFE, true);
    if (kind === "invalid subformat") { b = encodedWav(16, 6, true); }
    if (kind === "float16") v.setUint16(20, 3, true);
    if (kind === "unknown non-data size") v.setUint32(16, 0xFFFFFFFF, true);
    expect(() => decodePcm(b)).toThrow(AudioDecodeError);
  });
test("publication byte copy: caller overwrite during put preserves the stored hash", async () => {
  const audio = pcmAudio(20), stored: Uint8Array[] = [];
  const publication = createPublication({ async put(bytes) { audio.bytes.fill(0x55); stored.push(bytes.slice()); return { handle: "synthetic", lease_id: "synthetic", format: "wav" }; }, async commit() {} });
  const piece = await publication.piece(audio, { owner_epoch: 1, session_id: "synthetic", attempt_id: "synthetic", index: 0, piece_id: "synthetic", prefix: [], synthesis_ms: 1, spoken_text: "Copper boats drift", words, segments: 1, rate: "+0%", engine: { family: "synthetic", voice: "synthetic", profile_revision: "1" } }, new AbortController().signal);
  expect(audio.bytes.every(b => b === 0x55)).toBe(true);
  expect(piece.artifact.sha256).toBe(createHash("sha256").update(stored[0]).digest("hex"));
  expect(decodePcm(stored[0]).sample_count).toBe(20);
});
test("publication context contains only this piece's detached words", async () => { await read([251, 251, 251]); });

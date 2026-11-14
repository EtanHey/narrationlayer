import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderLocalTts, type LocalTtsRenderOptions } from "../src/pipelines/local-tts/index.js";
import { normalizeForSpeech, prepareSpeechChannels } from "../src/text-normalize.js";
import { computeContentHashKey } from "../src/pipelines/local-tts/take-cache.js";

function tone(hz: number) {
  const pcm = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * hz / 24000)), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF"); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function fixture(failures: number) {
  await mkdir("docs.local/w92-tests", { recursive: true });
  const dir = path.resolve(await mkdtemp("docs.local/w92-tests/case-"));
  let calls = 0;
  const cacheDir = path.join(dir, "cache");
  await mkdir(cacheDir);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body: unknown = await req.json();
    expect(body).toEqual(expect.objectContaining({ text: normalizeForSpeech("Hello moon.") }));
    calls++;
    // No failing take may have reached the cache before a subsequent request.
    expect(await readdir(cacheDir)).toEqual([]);
    return Response.json({ audio_b64: tone(calls <= failures ? 400 : 180).toString("base64") });
  } });
  const args: LocalTtsRenderOptions = { text: "Hello moon.", output: path.join(dir, "out.wav"),
    sampleRate: 24000, resolved: { daemonUrl: `http://127.0.0.1:${server.port}`, referenceClip: "synthetic.wav", referenceText: "Synthetic reference." },
    cacheDir, cache: true, authToken: "synthetic", timeoutMs: 10000, prepareSpeechChannels,
    takeChecks: { pitchCeilingHz: 300, retries: 2 } };
  return { args, dir, calls: () => calls, async close() { server.stop(true); await rm(dir, { recursive: true, force: true }); } };
}
const receipt = async (output: string) => JSON.parse(await readFile(`${output}.cache.json`, "utf8"));

test("failed takes retry fresh requests, publish only the passing take and keep its pieces", async () => {
  const f = await fixture(2);
  try {
    f.args.keepPiecesDir = path.join(f.dir, "kept");
    await renderLocalTts(f.args);
    expect(f.calls()).toBe(3);
    const r = await receipt(f.args.output);
    expect(r.takeChecks).toEqual({ attempts: 3, failures: [1, 2].map(attempt => ({ source: "render", attempt, reason: "pitch-over-ceiling" })), gaveUp: false });
    const frozen = path.join(f.args.cacheDir, `${r.cacheKey}.wav`);
    expect(await readFile(frozen)).toEqual(await readFile(f.args.output));
    expect(await readFile(path.join(f.args.keepPiecesDir, "piece-000.wav"))).toEqual(await readFile(f.args.output));
    delete f.args.keepPiecesDir;
    expect((await renderLocalTts(f.args)).kind).toBe("cache-hit");
    expect(f.calls()).toBe(3);
    expect((await receipt(f.args.output)).takeChecks.attempts).toBe(0);
  } finally { await f.close(); }
});

test("give-up records every failure and never publishes or caches rejected audio", async () => {
  const f = await fixture(Infinity);
  try {
    await expect(renderLocalTts(f.args)).rejects.toThrow("gave up");
    expect(f.calls()).toBe(3);
    const r = await receipt(f.args.output);
    expect(r.takeChecks.gaveUp).toBe(true);
    expect(r.takeChecks.failures).toHaveLength(3);
    expect(await readdir(f.args.cacheDir)).toEqual([]);
    expect(await Bun.file(f.args.output).exists()).toBe(false);
    expect((await readdir(f.dir)).some(n => n.includes(".checks-"))).toBe(false);
  } finally { await f.close(); }
});

test("old rejected cache hit is checked, then remade even with zero retries", async () => {
  const f = await fixture(0);
  try {
    f.args.takeChecks!.retries = 0;
    const key = computeContentHashKey({ spokenText: normalizeForSpeech(f.args.text), referenceClip: "synthetic.wav", referenceText: "Synthetic reference.", params: { takeChecks: f.args.takeChecks } });
    const cached = path.join(f.args.cacheDir, `${key}.wav`);
    f.args.cache = false;
    await renderLocalTts(f.args);
    const good = await readFile(f.args.output);
    f.args.cache = true;
    await writeFile(cached, tone(400));
    // Serve a passing request without the fixture's empty-cache assertion.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json({ audio_b64: tone(180).toString("base64") }); } });
    try {
      f.args.resolved.daemonUrl = `http://127.0.0.1:${server.port}`;
      await renderLocalTts(f.args);
      const r = await receipt(f.args.output);
      expect(r.takeChecks).toEqual({ attempts: 1, failures: [{ source: "cache", attempt: 0, reason: "pitch-over-ceiling" }], gaveUp: false });
      expect(await readFile(f.args.output)).toEqual(good);
      expect(await readFile(cached)).toEqual(good);
    } finally { server.stop(true); }
  } finally { await f.close(); }
});

test("checks off retains the warm frozen bytes, receipt and key", async () => {
  const f = await fixture(0);
  try {
    delete f.args.takeChecks;
    await renderLocalTts(f.args);
    const bytes = await readFile(f.args.output), r = await receipt(f.args.output);
    expect(r.takeChecks).toBeUndefined();
    expect((await renderLocalTts(f.args)).kind).toBe("cache-hit");
    expect(await readFile(f.args.output)).toEqual(bytes);
    expect(await receipt(f.args.output)).toEqual(r);
    expect(f.calls()).toBe(1);
  } finally { await f.close(); }
});

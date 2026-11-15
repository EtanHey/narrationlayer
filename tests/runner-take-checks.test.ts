import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderLocalTts, type LocalTtsRenderOptions } from "../src/pipelines/local-tts/index.js";
import { normalizeForSpeech, prepareSpeechChannels } from "../src/text-normalize.js";
import { computeContentHashKey } from "../src/pipelines/local-tts/take-cache.js";

function tone(hz: number, seconds = 1) {
  const count = Math.round(24000 * seconds);
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) pcm.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * hz / 24000)), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF"); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function fixture(failures: number, seconds = 1, vary = false, text = "Hello moon.") {
  await mkdir("docs.local/w92-tests", { recursive: true });
  const dir = path.resolve(await mkdtemp("docs.local/w92-tests/case-"));
  let calls = 0;
  const cacheDir = path.join(dir, "cache");
  await mkdir(cacheDir);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body: unknown = await req.json();
    expect(body).toEqual(expect.objectContaining({ text: normalizeForSpeech(text) }));
    calls++;
    // No failing take may have reached the cache before a subsequent request.
    expect(await readdir(cacheDir)).toEqual([]);
    return Response.json({ audio_b64: tone(calls <= failures ? 400 : vary ? 180 + calls : 180, seconds).toString("base64") });
  } });
  const args: LocalTtsRenderOptions = { text, output: path.join(dir, "out.wav"),
    sampleRate: 24000, resolved: { daemonUrl: `http://127.0.0.1:${server.port}`, referenceClip: "synthetic.wav", referenceText: "Synthetic reference." },
    cacheDir, cache: true, authToken: "synthetic", timeoutMs: 10000, prepareSpeechChannels,
    recogniseTake: async () => [{ word: "Hello", start: 0, end: 0.3 }, { word: "moon", start: 0.3, end: 0.6 }],
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
    expect(r.takeChecks).toMatchObject({ attempts: 3, failures: [1, 2].map(attempt => ({ source: "render", attempt, reason: "pitch-over-ceiling" })), gaveUp: false });
    const frozen = path.join(f.args.cacheDir, `${r.cacheKey}.wav`);
    expect(await readFile(frozen)).toEqual(await readFile(f.args.output));
    expect(await readFile(path.join(f.args.keepPiecesDir, "piece-000.wav"))).toEqual(await readFile(f.args.output));
    delete f.args.keepPiecesDir;
    expect((await renderLocalTts(f.args)).kind).toBe("cache-hit");
    expect(f.calls()).toBe(3);
    expect((await receipt(f.args.output)).takeChecks.attempts).toBe(0);
  } finally { await f.close(); }
});

test("give-up reports failures without publishing audio or a receipt", async () => {
  const f = await fixture(Infinity);
  try {
    await expect(renderLocalTts(f.args)).rejects.toThrow("gave up");
    expect(f.calls()).toBe(3);
    expect(await Bun.file(`${f.args.output}.cache.json`).exists()).toBe(false);
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
      expect(r.takeChecks).toMatchObject({ attempts: 1, failures: [{ source: "cache", attempt: 0, reason: "pitch-over-ceiling" }], gaveUp: false });
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


test("check execution error exits 2 without a fresh request or publication", async () => {
  const f = await fixture(0);
  try {
    const reference = path.join(f.dir, "reference.wav"), auth = path.join(f.dir, "auth");
    await writeFile(reference, tone(180));
    await writeFile(auth, "synthetic");
    const key = computeContentHashKey({ spokenText: normalizeForSpeech(f.args.text),
      referenceClip: reference, referenceText: "Synthetic reference.", params: { takeChecks: f.args.takeChecks } });
    const cached = path.join(f.args.cacheDir, `${key}.wav`);
    await writeFile(cached, "not audio");
    await writeFile(f.args.output, "previous accepted output");
    const child = Bun.spawn([process.execPath, "bin/local-tts-runner.ts", "--text", f.args.text,
      "--output", f.args.output, "--reference", reference, "--reference-text", "Synthetic reference.",
      "--auth-token-file", auth, "--daemon-url", f.args.resolved.daemonUrl, "--cache-dir", f.args.cacheDir,
      "--take-checks", "--pitch-ceiling", "300"], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(2);
    expect(stderr).toContain("no retry performed");
    expect(f.calls()).toBe(0);
    expect(await readFile(f.args.output, "utf8")).toBe("previous accepted output");
    expect(await readFile(cached, "utf8")).toBe("not audio");
    expect(await Bun.file(`${f.args.output}.cache.json`).exists()).toBe(false);
    expect((await readdir(f.dir)).some(n => n.includes(".checks-"))).toBe(false);
  } finally { await f.close(); }
});


test("a 0.6 s take passes without retry and reports pitch not judged", async () => {
  const f = await fixture(Infinity, 0.6);
  try {
    await renderLocalTts(f.args);
    expect(f.calls()).toBe(1);
    expect((await receipt(f.args.output)).takeChecks).toMatchObject({ attempts: 1, failures: [], gaveUp: false,
      pitchNote: "not judged: shorter than one window" });
    expect((await renderLocalTts(f.args)).kind).toBe("cache-hit");
    expect(f.calls()).toBe(1);
    expect((await receipt(f.args.output)).takeChecks.pitchNote).toBe("not judged: shorter than one window");
  } finally { await f.close(); }
});

test("CLI give-up preserves the previous WAV, spoken text and receipt byte for byte", async () => {
  const f = await fixture(Infinity);
  try {
    const reference = path.join(f.dir, "reference.wav"), auth = path.join(f.dir, "auth");
    await writeFile(reference, tone(180));
    await writeFile(auth, "synthetic");
    const previous = [tone(180), Buffer.from("Earlier synthetic input."), Buffer.from('{"cacheKey":"previous-key"}\n')];
    const files = [f.args.output, `${f.args.output}.spoken.txt`, `${f.args.output}.cache.json`];
    for (const [i, file] of files.entries()) await writeFile(file, previous[i]!);
    const child = Bun.spawn([process.execPath, "bin/local-tts-runner.ts", "--text", f.args.text,
      "--output", f.args.output, "--reference", reference, "--reference-text", "Synthetic reference.",
      "--auth-token-file", auth, "--daemon-url", f.args.resolved.daemonUrl, "--cache-dir", f.args.cacheDir,
      "--take-checks", "--pitch-ceiling", "300"], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(f.calls()).toBe(3);
    expect(stderr).toContain('"gaveUp":true');
    expect(stderr).toContain('"attempts":3');
    expect(stderr.match(/pitch-over-ceiling/g)).toHaveLength(3);
    for (const [i, file] of files.entries()) expect(await readFile(file)).toEqual(previous[i]!);
    expect(await readdir(f.args.cacheDir)).toEqual([]);
    expect((await readdir(f.dir)).some(n => n.includes(".checks-"))).toBe(false);
  } finally { await f.close(); }
});

test("whole-take mismatch retries and rejects cached words before publication", async () => {
  const f = await fixture(0);
  let checks = 0;
  f.args.recogniseTake = async () => ++checks < 3
    ? [{ word: "Hello", start: 0, end: 0.3 }, { word: "sun", start: 0.3, end: 0.6 }]
    : [{ word: "Hello", start: 0, end: 0.3 }, { word: "moon", start: 0.3, end: 0.6 }];
  try {
    await renderLocalTts(f.args);
    expect(f.calls()).toBe(3);
    const r = await receipt(f.args.output);
    expect(r.takeChecks.failures).toHaveLength(2);
    expect(r.takeChecks.failures[0].reason).toContain("word-mismatch:");
    expect(r.takeChecks.failures[0].reason).toContain("substitution");
    await renderLocalTts(f.args);
    expect(checks).toBe(4);
    expect((await receipt(f.args.output)).takeChecks.wordMatch).toMatchObject({ pass: true, setting: "a", edits: [] });
    expect(f.calls()).toBe(3);
  } finally { await f.close(); }
});

for (const [name, counts, selected] of [
  ["identical failures keep earliest", [1, 1, 1], 0],
  ["middle attempt has fewer edits", [2, 1, 2], 1],
] as const) {
  test(`word retry fallback: ${name}`, async () => {
    const f = await fixture(0, 1, true);
    const takes: Buffer<ArrayBuffer>[] = [];
    f.args.keepPiecesDir = path.join(f.dir, "kept");
    f.args.recogniseTake = async wav => {
      const index = takes.length;
      const bytes = await readFile(wav);
      takes.push(bytes);
      return [{ word: counts[index] === 2 ? "Goodbye" : "Hello", start: 0, end: 0.3 },
        { word: "sun", start: 0.3, end: 0.6 }];
    };
    try {
      await renderLocalTts(f.args);
      expect(f.calls()).toBe(3);
      expect(await readFile(f.args.output)).toEqual(takes[selected]);
      expect(await readdir(f.args.cacheDir)).toEqual([]);
      const r = await receipt(f.args.output);
      expect(r.takeChecks.gaveUp).toBe(false);
      expect(r.takeChecks.wordMatch).toMatchObject({ pass: false, keptBest: true,
        attempts: counts.map((editCount, i) => ({ source: "render", attempt: i + 1, editCount })) });
      expect(r.cacheEnabled).toBe(false);
      expect(await readFile(path.join(f.args.keepPiecesDir!, "piece-000.wav"))).toEqual(takes[selected]);
      expect(await Bun.file(path.join(f.args.keepPiecesDir!, "pieces.json")).exists()).toBe(true);
    } finally { await f.close(); }
  });
}

for (const pitchFirst of [false, true]) {
  test(`best word take survives final pitch rejection (first pitch failure: ${pitchFirst})`, async () => {
    const f = await fixture(pitchFirst ? 1 : 0, 1, true);
    const takes: Buffer<ArrayBuffer>[] = [];
    f.args.recogniseTake = async wav => {
      takes.push(await readFile(wav));
      if (pitchFirst || takes.length === 2) f.args.takeChecks!.pitchCeilingHz = 100;
      return [{ word: "Hello", start: 0, end: 0.3 }, { word: "sun", start: 0.3, end: 0.6 }];
    };
    try {
      await renderLocalTts(f.args);
      expect(f.calls()).toBe(3);
      expect(await readFile(f.args.output)).toEqual(takes[0]);
      const r = await receipt(f.args.output);
      expect(r.takeChecks.wordMatch.keptBest).toBe(true);
      expect(r.takeChecks.wordMatch.attempts.map((a: { editCount: number | null }) => a.editCount))
        .toEqual(pitchFirst ? [null, 1, null] : [1, 1, null]);
      expect(await readdir(f.args.cacheDir)).toEqual([]);
    } finally { await f.close(); }
  });
}
test("recognizer rejection retains the cause, publishes nothing and does not retry", async () => {
  const f = await fixture(0);
  f.args.recogniseTake = async () => { throw new Error("recognizer unavailable"); };
  try {
    await expect(renderLocalTts(f.args)).rejects.toThrow("no retry performed: recognizer unavailable");
    expect(f.calls()).toBe(1);
    expect(await Bun.file(f.args.output).exists()).toBe(false);
    expect(await readdir(f.args.cacheDir)).toEqual([]);
  } finally { await f.close(); }
});
test("non-Latin spoken text skips recognition with an explicit receipt note", async () => {
  const f = await fixture(0, 1, false, "שלום ירח");
  f.args.recogniseTake = async () => { throw new Error("must not be called"); };
  try {
    await renderLocalTts(f.args);
    expect(f.calls()).toBe(1);
    expect((await receipt(f.args.output)).takeChecks.wordMatch).toMatchObject({
      note: "not judged: no Latin-script words", model: "not-run", edits: [] });
  } finally { await f.close(); }
});
test("word flags require take-checks and name the flags in the error", () => {
  const run = Bun.spawnSync([process.execPath, "bin/local-tts-runner.ts", "--word-check-setting", "a"]);
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("--word-check-setting and --word-dictionary require --take-checks");
});

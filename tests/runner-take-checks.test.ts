import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderLocalTts, type LocalTtsRenderOptions } from "../src/pipelines/local-tts/index.js";
import { normalizeForSpeech, prepareSpeechChannels } from "../src/text-normalize.js";
import { hashReferenceClip, computeContentHashKey } from "../src/pipelines/local-tts/take-cache.js";

// A finished take decays into a little silence over its last 0.15 s; a cut one stops at full level.
function tone(hz: number, seconds = 1, ending: "decay" | "cut" = "decay", amplitude = 4000) {
  const count = Math.round(24000 * seconds), fade = count - 3600, quiet = count - 720;
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const gain = ending === "cut" || i < fade ? 1 : i < quiet ? Math.exp(-(i - fade) / 360) : 0;
    pcm.writeInt16LE(Math.round(amplitude * gain * Math.sin(i * 2 * Math.PI * hz / 24000)), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF"); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function fixture(failures: number, seconds = 1, vary = false, text = "Hello moon.", cuts = 0) {
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
    return Response.json({ audio_b64: tone(calls <= failures ? 400 : vary ? 180 + calls : 180, seconds,
      calls <= cuts ? "cut" : "decay").toString("base64") });
  } });
  await writeFile(path.join(dir, "reference.wav"), tone(180));
  const args: LocalTtsRenderOptions = { text, output: path.join(dir, "out.wav"),
    sampleRate: 24000, resolved: { daemonUrl: `http://127.0.0.1:${server.port}`, referenceClip: path.join(dir, "reference.wav"), referenceText: "Synthetic reference." },
    cacheDir, cache: true, authToken: "synthetic", timeoutMs: 10000, prepareSpeechChannels,
    recogniseTake: async () => [{ word: "Hello", start: 0, end: 0.3 }, { word: "moon", start: 0.3, end: 0.6 }],
    takeChecks: { pitchCeilingHz: 300, retries: 2 } };
  return { args, dir, calls: () => calls, async close() { server.stop(true); await rm(dir, { recursive: true, force: true }); } };
}
const receipt = async (output: string) => JSON.parse(await readFile(`${output}.cache.json`, "utf8"));

for (const wrongHintedWord of [false, true]) {
  test(`hinted take expects display spelling; wrong hinted word=${wrongHintedWord}`, async () => {
    const f = await fixture(0, 1, false, "We live{say:liv} here.");
    f.args.takeChecks!.retries = 0;
    f.args.recogniseTake = async () =>
      `We ${wrongHintedWord ? "sleep" : "live"} here.`.split(/\s+/)
        .map((word, index) => ({ word, start: index * .1, end: (index + 1) * .1 }));
    try {
      await renderLocalTts(f.args);
      const evidence = (await receipt(f.args.output)).takeChecks;
      expect(evidence.wordMatch.pass).toBe(!wrongHintedWord);
      expect(evidence.gaveUp).toBe(false);
      expect(f.calls()).toBe(1);
      expect(await readFile(`${f.args.output}.spoken.txt`, "utf8")).toBe("We liv here.");
      if (wrongHintedWord) {
        expect(evidence.wordMatch.keptBest).toBe(true);
        expect(evidence.wordMatch.edits).toContainEqual(expect.objectContaining({ kind: "substitution", sentIndex: 1 }));
      } else {
        expect(evidence.wordMatch.edits).toEqual([]);
        expect((await renderLocalTts(f.args)).kind).toBe("cache-hit");
        expect(f.calls()).toBe(1);
        expect((await receipt(f.args.output)).takeChecks.wordMatch.pass).toBe(true);
      }
    } finally { await f.close(); }
  });
}

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
    const key = computeContentHashKey({ spokenText: normalizeForSpeech(f.args.text), referenceAudioSha256: await hashReferenceClip(f.args.resolved.referenceClip), referenceText: "Synthetic reference.", params: { takeChecks: f.args.takeChecks } });
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
      referenceAudioSha256: await hashReferenceClip(reference), referenceText: "Synthetic reference.", params: { takeChecks: f.args.takeChecks } });
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


test("reference hash is reused within retries and read afresh for the next run", async () => {
  const f = await fixture(0);
  try {
    const reference = f.args.resolved.referenceClip;
    const original = await readFile(reference);
    let attempts = 0;
    f.args.recogniseTake = async () => {
      attempts++;
      await rm(reference, { force: true });
      return [{ word: "Hello", start: 0, end: 0.3 }, { word: attempts === 1 ? "sun" : "moon", start: 0.3, end: 0.6 }];
    };
    await renderLocalTts(f.args);
    expect(f.calls()).toBe(2);
    const first = (await receipt(f.args.output)).cacheKey;
    await expect(renderLocalTts(f.args)).rejects.toThrow("cannot read reference audio for take cache identity");
    await rm(f.args.cacheDir, { recursive: true });
    await mkdir(f.args.cacheDir);
    await writeFile(reference, Buffer.concat([original, Buffer.from([1])]));
    await renderLocalTts(f.args);
    expect((await receipt(f.args.output)).cacheKey).not.toBe(first);
  } finally { await f.close(); }
});

test("a take cut mid-sound is re-made; the kept take records its decayed ending", async () => {
  const f = await fixture(0, 1, false, "Hello moon.", 2);
  try {
    await renderLocalTts(f.args);
    expect(f.calls()).toBe(3);
    const r = await receipt(f.args.output);
    expect(r.takeChecks.failures.map((x: { attempt: number }) => x.attempt)).toEqual([1, 2]);
    for (const failure of r.takeChecks.failures) expect(failure.reason).toStartWith('cut-ending:{"reason":"tail-at-speech-level"');
    expect(r.takeChecks.cutEnding).toMatchObject({ failed: false, reason: null, lastWordEndSeconds: 0.6 });
    expect(r.takeChecks.cutEnding.tailRelDb).toBeLessThan(-30);
    expect(r.takeChecks.wordMatch.pass).toBe(true);
    expect(await readFile(path.join(f.args.cacheDir, `${r.cacheKey}.wav`))).toEqual(await readFile(f.args.output));
  } finally { await f.close(); }
});

test("takes that are always cut give up and publish nothing", async () => {
  const f = await fixture(0, 1, false, "Hello moon.", Infinity);
  try {
    await expect(renderLocalTts(f.args)).rejects.toThrow("gave up");
    expect(f.calls()).toBe(3);
    expect(await Bun.file(f.args.output).exists()).toBe(false);
    expect(await readdir(f.args.cacheDir)).toEqual([]);
  } finally { await f.close(); }
});

test("quiet join boosted to the published level is rejected", async () => {
  const f = await fixture(0, 1, false, "Hello moon. Hello sun.");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body: unknown = await req.json();
    const cut = typeof body === "object" && body !== null && "text" in body && body.text === "Hello moon.";
    return Response.json({ audio_b64: tone(180, 1, cut ? "cut" : "decay", 160).toString("base64") });
  } });
  f.args.resolved = { ...f.args.resolved, daemonUrl: `http://127.0.0.1:${server.port}`,
    sentencePauseSeconds: 0.3, loudnessTargetDb: -20 };
  f.args.takeChecks!.retries = 0;
  f.args.recogniseTake = async () => [{ word: "Hello", start: 0, end: 0.3 }, { word: "moon.", start: 0.3, end: 0.6 },
    { word: "Hello", start: 1.3, end: 1.6 }, { word: "sun.", start: 1.6, end: 1.9 }];
  try {
    await expect(renderLocalTts(f.args)).rejects.toThrow("cut-join:");
    expect(await Bun.file(f.args.output).exists()).toBe(false);
    expect(await readdir(f.args.cacheDir)).toEqual([]);
  } finally { server.stop(true); await f.close(); }
});

for (const cutTakes of [1, Infinity]) {
  test(`a breathing piece cut at its join fails the take (cut takes: ${cutTakes})`, async () => {
    const f = await fixture(0, 1, false, "Hello moon. Hello sun.");
    let cutRequests = 0;
    // Only the first piece is ever cut; the take's own ending (the last piece) always decays.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const { text } = await req.json() as { text: string };
      const cut = text === "Hello moon." && ++cutRequests <= cutTakes;
      return Response.json({ audio_b64: tone(180, 1, cut ? "cut" : "decay").toString("base64") });
    } });
    f.args.resolved = { ...f.args.resolved, daemonUrl: `http://127.0.0.1:${server.port}`, sentencePauseSeconds: 0.3 };
    f.args.recogniseTake = async () => [{ word: "Hello", start: 0, end: 0.3 }, { word: "moon.", start: 0.3, end: 0.6 },
      { word: "Hello", start: 1.3, end: 1.6 }, { word: "sun.", start: 1.6, end: 1.9 }];
    try {
      if (cutTakes === Infinity) {
        await expect(renderLocalTts(f.args)).rejects.toThrow("gave up");
        expect(cutRequests).toBe(3);
        expect(await Bun.file(f.args.output).exists()).toBe(false);
        expect(await readdir(f.args.cacheDir)).toEqual([]);
        return;
      }
      await renderLocalTts(f.args);
      expect(cutRequests).toBe(2);
      const r = await receipt(f.args.output);
      expect(r.takeChecks.failures).toHaveLength(1);
      expect(r.takeChecks.failures[0].reason)
        .toStartWith('cut-join:{"piece":1,"of":2,"text":"Hello moon.","reason":"tail-at-speech-level"');
      expect(r.takeChecks.cutEnding).toMatchObject({ failed: false, reason: null });
      expect(r.takeChecks.cutJoins).toEqual({ failed: false, piecesChecked: 1, cuts: [] });
      expect(await readFile(path.join(f.args.cacheDir, `${r.cacheKey}.wav`))).toEqual(await readFile(f.args.output));
      expect((await readdir(f.dir)).filter(n => n.includes("pieces") || n.includes(".checks-"))).toEqual([]);
      expect((await renderLocalTts(f.args)).kind).toBe("cache-hit");
      expect((await receipt(f.args.output)).takeChecks.cutJoins)
        .toEqual({ failed: false, piecesChecked: 0, cuts: [], note: "not judged: a cache hit keeps no pieces" });
    } finally { server.stop(true); await f.close(); }
  });
}

test("a cut take is never kept as the best word-mismatch take, even with fewer edits", async () => {
  const f = await fixture(0, 1, true, "Hello moon.", 0);
  const takes: Buffer<ArrayBuffer>[] = [];
  // The second take is cut and has the fewest edits; the first decayed take must be kept.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    const n = takes.length + 1;
    return Response.json({ audio_b64: tone(180 + n, 1, n === 2 ? "cut" : "decay").toString("base64") });
  } });
  f.args.resolved.daemonUrl = `http://127.0.0.1:${server.port}`;
  f.args.recogniseTake = async wav => {
    takes.push(await readFile(wav));
    return takes.length === 2 ? [{ word: "Hello", start: 0, end: 0.3 }, { word: "sun", start: 0.3, end: 0.6 }]
      : [{ word: "Goodbye", start: 0, end: 0.3 }, { word: "sun", start: 0.3, end: 0.6 }];
  };
  try {
    await renderLocalTts(f.args);
    expect(takes).toHaveLength(3);
    expect(await readFile(f.args.output)).toEqual(takes[0]);
    const r = await receipt(f.args.output);
    expect(r.takeChecks.wordMatch).toMatchObject({ keptBest: true, pass: false });
    expect(r.takeChecks.failures[1].reason).toStartWith("cut-ending:");
    expect(r.takeChecks.cutEnding).toMatchObject({ failed: false, reason: null });
    expect(await readdir(f.args.cacheDir)).toEqual([]);
  } finally { server.stop(true); await f.close(); }
});

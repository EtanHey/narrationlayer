import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderLocalTts, type ResolvedLocalTtsVoice } from "../src/pipelines/local-tts/index.js";
import { renderSegment } from "../src/pipelines/job-render/index.js";
import { prepareSpeechChannels } from "../src/text-normalize.js";

// The Qwen3-TTS clone model stops a long generation at about 10 s, often mid-word. Every
// path, with profile pauses or without, must cut text over 24 words before the daemon.

function silence(seconds: number) {
  const pcm = Buffer.alloc(Math.round(24000 * seconds) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF"); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
// 35 words, three commas.
const LONG =
  "When the build finished late on Tuesday night, the team opened the dashboard, checked every chart against the numbers from the morning, and found that the cache had quietly doubled its size without warning anyone.";
// 20 words: under the 24-word limit.
const MEDIUM = "The agent read the handoff file, compared it with the open pull requests, and asked the lead what to merge.";

async function runnerRequests(text: string, referenceSeconds: number, pauses: Partial<ResolvedLocalTtsVoice>) {
  await mkdir("docs.local/p34-wall-tests", { recursive: true });
  const dir = path.resolve(await mkdtemp("docs.local/p34-wall-tests/case-"));
  const texts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    texts.push(((await req.json()) as { text: string }).text);
    return Response.json({ audio_b64: silence(0.2).toString("base64") });
  } });
  try {
    await writeFile(path.join(dir, "reference.wav"), silence(referenceSeconds));
    const result = await renderLocalTts({
      text, output: path.join(dir, "out.wav"), sampleRate: 24000, cacheDir: path.join(dir, "cache"), cache: false,
      authToken: "synthetic", timeoutMs: 10000, prepareSpeechChannels,
      resolved: { daemonUrl: `http://127.0.0.1:${server.port}`, referenceClip: path.join(dir, "reference.wav"),
        referenceText: "Synthetic reference.", ...pauses },
    });
    return { texts, result };
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}

test("a profile with no pause settings cuts a 35-word sentence before the daemon (10 s reference)", async () => {
  const { texts, result } = await runnerRequests(LONG, 10, {});
  // The whole segment is generated first, as before; the cut pieces then replace it.
  expect(texts.length).toBeGreaterThan(1);
  expect(texts[0]).toBe(LONG);
  const pieces = texts.slice(1);
  expect(pieces).toEqual([
    "When the build finished late on Tuesday night, the team opened the dashboard,",
    "checked every chart against the numbers from the morning, and found that the cache had quietly doubled its size without warning anyone.",
  ]);
  for (const piece of pieces) expect(words(piece)).toBeLessThanOrEqual(24);
  expect(result.kind === "rendered" && result.breathingNote).toBe(" long-split=2pc(max=24w,pause=0.14s)");
});

test("a profile with no pause settings leaves text the reference can hold as one generation", async () => {
  const { texts, result } = await runnerRequests("First sentence. Second sentence, short.", 10, {});
  expect(texts).toEqual(["First sentence. Second sentence, short."]);
  expect(result.kind === "rendered" && result.breathingNote).toBe("");
});

test("a no-pause profile cuts at a sentence end before any comma", async () => {
  const text = "We measured every take, all of them, by hand. Then we kept the simplest rule, the one that never lost a single sound at all, and moved on.";
  const { texts } = await runnerRequests(text, 10, {});
  expect(texts.slice(1)).toEqual([
    "We measured every take, all of them, by hand.",
    "Then we kept the simplest rule, the one that never lost a single sound at all, and moved on.",
  ]);
});

// Measured live: a 5.2 s reference ran 20-word takes to 5.6-7.0 s, past its own length, with
// every word kept, so the limit is not scaled down for a short reference.
test("a reference shorter than 10 s keeps the 24-word limit: 20 words stay one generation, 35 are cut", async () => {
  const medium = await runnerRequests(MEDIUM, 5, {});
  expect(medium.texts).toEqual([MEDIUM]);
  const long = await runnerRequests(LONG, 5, {});
  expect(long.texts.slice(1).map(words)).toEqual([13, 22]);
});

test("the job path cuts a long utterance even with pause_strategy none", async () => {
  await mkdir("docs.local/p34-wall-tests", { recursive: true });
  const dir = path.resolve(await mkdtemp("docs.local/p34-wall-tests/job-"));
  const texts: string[] = [];
  let chunks: { pauseAfterSeconds: number }[] = [];
  try {
    await writeFile(path.join(dir, "reference.wav"), silence(10));
    await renderSegment("seg-1", { title: "Long", script: LONG }, {
      artifactsDir: path.join(dir, "artifacts"), dataDir: dir, jobId: "job-1", voiceProfile: "synthetic",
      fetch: async (_url: string | URL | Request, init?: RequestInit) => {
        texts.push(JSON.parse(String(init?.body)).text);
        return Response.json({ audio_b64: Buffer.from("audio").toString("base64"), audio_duration_ms: 1500 });
      },
    }, {
      daemon_url: "http://127.0.0.1:1", auth_token: "synthetic", reference_clip: path.join(dir, "reference.wav"),
      reference_text: "Synthetic reference.", pause_strategy: "none", timing_backend: "none",
      audio_duration_probe: async () => 3,
      audio_assembler: async ({ chunks: assembled, outputPath }) => { chunks = assembled; await writeFile(outputPath, "assembled"); },
    });
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) expect(words(text)).toBeLessThanOrEqual(24);
    expect(texts.join(" ")).toBe(LONG);
    expect(chunks.map((c) => c.pauseAfterSeconds)).toEqual([0.14, 0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

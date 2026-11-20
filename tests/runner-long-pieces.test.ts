import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderLocalTts } from "../src/pipelines/local-tts/index.js";
import { planBreathingPieces } from "../src/pipelines/local-tts/breathing.js";
import { prepareSpeechChannels } from "../src/text-normalize.js";
import { MAX_BREATHING_PIECE_WORDS } from "../src/plan/breathing.js";

// The Qwen3-TTS clone path stops a generation at about 10 s, mid-word. With breathing on,
// the runner must never ask the daemon for one piece longer than MAX_BREATHING_PIECE_WORDS.

function silence(seconds: number) {
  const pcm = Buffer.alloc(Math.round(24000 * seconds) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF"); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const LONG =
  "When the build finished late on Tuesday night, the team opened the dashboard, checked every chart against the numbers from the morning, and found that the cache had quietly doubled its size without warning anyone.";

for (const breathing of [true, false]) {
  test(`every synthesis request preserves the selected model (breathing=${breathing})`, async () => {
    const dir = await mkdtemp(path.join((await import("node:os")).tmpdir(), "runner-model-"));
    const requests: { text: string; model?: string }[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const body = await req.json();
      if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") {
        throw new Error("Expected synthesis request text");
      }
      requests.push({ text: body.text, model: "model" in body && typeof body.model === "string" ? body.model : undefined });
      return Response.json({ audio_b64: silence(0.2).toString("base64") });
    } });
    try {
      const referenceClip = path.join(dir, "synthetic.wav");
      await writeFile(referenceClip, silence(1));
      const result = await renderLocalTts({
        text: Array.from({ length: 35 }, (_, i) => `word${i}`).join(" "),
        output: path.join(dir, "out.wav"), sampleRate: 24000,
        cacheDir: path.join(dir, "cache"), cache: false,
        authToken: "synthetic", timeoutMs: 10000, prepareSpeechChannels,
        resolved: {
          daemonUrl: `http://127.0.0.1:${server.port}`, referenceClip,
          referenceText: "Synthetic silence.", model: "custom-model",
          ...(breathing ? { sentencePauseSeconds: 0.5, commaPauseSeconds: 0 } : {}),
        },
      });
      expect(result.kind).toBe("rendered");
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(requests.map(({ model }) => model)).toEqual(requests.map(() => "custom-model"));
      for (const piece of requests.slice(1)) {
        expect(piece.text.split(/\s+/).length).toBeLessThanOrEqual(MAX_BREATHING_PIECE_WORDS);
      }
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("a breathing render sends a long sentence as clause pieces, none over the word limit", async () => {
  await mkdir("docs.local/w144-tests", { recursive: true });
  const dir = path.resolve(await mkdtemp("docs.local/w144-tests/case-"));
  const texts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    texts.push(((await req.json()) as { text: string }).text);
    return Response.json({ audio_b64: silence(0.2).toString("base64") });
  } });
  try {
    await writeFile(path.join(dir, "reference.wav"), silence(1));
    const result = await renderLocalTts({
      text: LONG, output: path.join(dir, "out.wav"), sampleRate: 24000, cacheDir: path.join(dir, "cache"), cache: false,
      authToken: "synthetic", timeoutMs: 10000, prepareSpeechChannels,
      resolved: { daemonUrl: `http://127.0.0.1:${server.port}`, referenceClip: path.join(dir, "reference.wav"),
        referenceText: "Synthetic reference.", sentencePauseSeconds: 0.5, commaPauseSeconds: 0 },
    });
    expect(result.kind).toBe("rendered");
    // The first request is the whole segment, as before; breathing then re-makes it in pieces.
    const pieces = texts.slice(1);
    expect(pieces).toEqual([
      "When the build finished late on Tuesday night, the team opened the dashboard,",
      "checked every chart against the numbers from the morning, and found that the cache had quietly doubled its size without warning anyone.",
    ]);
    for (const text of pieces) expect(text.split(/\s+/).length).toBeLessThanOrEqual(MAX_BREATHING_PIECE_WORDS);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache join planning includes splits of a long single sentence", () => {
  const pieces = planBreathingPieces(Array.from({ length: 35 }, (_, i) => `word${i}`).join(" "), 0.5, 0);
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) expect(piece.text.split(/\s+/).length).toBeLessThanOrEqual(MAX_BREATHING_PIECE_WORDS);
});

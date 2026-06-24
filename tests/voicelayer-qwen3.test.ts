import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { renderSegment } from "../src/renderers/voicelayer-qwen3.js";

function createTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "narrationlayer-qwen3-"));
}

test("VoiceLayer Qwen3 adapter uses measured audio duration instead of daemon generation time", async () => {
  const dataDir = createTempDir();
  const fetchCalls: unknown[] = [];
  const fetchMock = async (url: string, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({ url, init });
    return new Response(
      JSON.stringify({
        audio_b64: Buffer.from("fake mp3 bytes").toString("base64"),
        duration_ms: 1234,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const result = await renderSegment(
      "seg-1",
      {
        title: "Intro",
        script: "Hello from the local daemon",
      },
      {
        artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
        dataDir,
        jobId: "job-1",
        voiceProfile: "neutral-reader",
        fetch: fetchMock,
      },
      {
        daemon_url: "http://127.0.0.1:8880",
        auth_token: "test-token",
        reference_clip: "/tmp/public-placeholder.wav",
        reference_text: "placeholder reference text",
        audio_duration_probe: async () => 17.36,
      },
    );

    expect(fetchCalls).toHaveLength(1);
    expect(await Bun.file(result.audio_path).text()).toBe("fake mp3 bytes");
    expect(result.duration_seconds).toBe(17.36);

    const wordsPayload = JSON.parse(await Bun.file(result.words_path).text());
    expect(wordsPayload).toEqual({
      job_id: "job-1",
      segment_id: "seg-1",
      timing: {
        status: "unavailable",
        source: "voicelayer-qwen3",
        reason: "backend_did_not_return_word_timings",
      },
      words: [],
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("VoiceLayer Qwen3 adapter forwards LoRA adapter path and scale to the daemon", async () => {
  const dataDir = createTempDir();
  const requestBodies: unknown[] = [];
  const fetchMock = async (_url: string, init?: RequestInit): Promise<Response> => {
    requestBodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        audio_b64: Buffer.from("fake mp3 bytes").toString("base64"),
        duration_ms: 1000,
        lora_applied: true,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    await renderSegment(
      "seg-1",
      {
        title: "Intro",
        script: "LoRA should be active.",
      },
      {
        artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
        dataDir,
        jobId: "job-1",
        voiceProfile: "theo-qwen3-lora",
        fetch: fetchMock,
      },
      {
        daemon_url: "http://127.0.0.1:8880",
        auth_token: "test-token",
        reference_clip: "/tmp/public-placeholder.wav",
        reference_text: "placeholder reference text",
        lora_adapter_path: "/private/adapters/theo-qwen3/checkpoint-epoch-10",
        lora_scale: 0.3,
        audio_duration_probe: async () => 1.2,
      },
    );

    expect(requestBodies).toEqual([
      {
        text: "LoRA should be active.",
        reference_wav: "/tmp/public-placeholder.wav",
        reference_text: "placeholder reference text",
        lora_adapter_path: "/private/adapters/theo-qwen3/checkpoint-epoch-10",
        lora_scale: 0.3,
      },
    ]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("VoiceLayer Qwen3 adapter forwards model pin and stamps render provenance", async () => {
  const dataDir = createTempDir();
  const refClip = path.join(dataDir, "theo-c4s-reference.wav");
  await writeFile(refClip, "bright-reference-audio");
  const expectedSha = createHash("sha256")
    .update("bright-reference-audio")
    .digest("hex");
  const requestBodies: unknown[] = [];
  const fetchMock = async (_url: string, init?: RequestInit): Promise<Response> => {
    requestBodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        audio_b64: Buffer.from("fake mp3 bytes").toString("base64"),
        duration_ms: 1000,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const result = await renderSegment(
      "seg-1",
      {
        title: "Intro",
        script: "The accepted profile should be stamped.",
      },
      {
        artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
        dataDir,
        jobId: "job-1",
        voiceProfile: "theo-c4s",
        fetch: fetchMock,
      },
      {
        daemon_url: "http://127.0.0.1:8880",
        auth_token: "test-token",
        reference_clip: refClip,
        reference_text: "bright reference text",
        profile_id: "theo-c4s",
        profile_version: "c4s",
        model: "qwen3-tts-4bit",
        narrationlayer_commit: "abc1234",
        audio_duration_probe: async () => 1.2,
      },
    );

    expect(requestBodies).toEqual([
      {
        text: "The accepted profile should be stamped.",
        reference_wav: refClip,
        reference_text: "bright reference text",
        model: "qwen3-tts-4bit",
      },
    ]);
    expect(result.provenance).toEqual({
      profile_id: "theo-c4s",
      profile_version: "c4s",
      reference_clip_sha: expectedSha,
      model: "qwen3-tts-4bit",
      narrationlayer_commit: "abc1234",
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("VoiceLayer Qwen3 adapter fails closed when a configured LoRA is not acknowledged by the daemon", async () => {
  const dataDir = createTempDir();
  const fetchMock = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        audio_b64: Buffer.from("fake mp3 bytes").toString("base64"),
        duration_ms: 1000,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

  try {
    await expect(
      renderSegment(
        "seg-1",
        {
          title: "Intro",
          script: "LoRA should be active.",
        },
        {
          artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
          dataDir,
          jobId: "job-1",
          voiceProfile: "theo-qwen3-lora",
          fetch: fetchMock,
        },
        {
          daemon_url: "http://127.0.0.1:8880",
          auth_token: "test-token",
          reference_clip: "/tmp/public-placeholder.wav",
          reference_text: "placeholder reference text",
          lora_adapter_path: "/private/adapters/theo-qwen3/checkpoint-epoch-10",
          lora_scale: 0.3,
          audio_duration_probe: async () => 1.2,
        },
      ),
    ).rejects.toThrow("daemon did not confirm LoRA adapter");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("VoiceLayer Qwen3 adapter can fill missing daemon timings from an aligner", async () => {
  const dataDir = createTempDir();
  const fetchMock = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        audio_b64: Buffer.from("fake mp3 bytes").toString("base64"),
        duration_ms: 1234,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

  try {
    const result = await renderSegment(
      "seg-1",
      {
        title: "Intro",
        script: "Hello from the local daemon.",
      },
      {
        artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
        dataDir,
        jobId: "job-1",
        voiceProfile: "neutral-reader",
        fetch: fetchMock,
      },
      {
        daemon_url: "http://127.0.0.1:8880",
        auth_token: "test-token",
        reference_clip: "/tmp/public-placeholder.wav",
        reference_text: "placeholder reference text",
        audio_duration_probe: async () => 2.4,
        word_timing_provider: async () => [
          { index: 0, word: "Hello", start: 0.1, end: 0.4 },
          { index: 1, word: "daemon.", start: 1.6, end: 2.2, confidence: 0.92 },
        ],
      },
    );

    const wordsPayload = JSON.parse(await Bun.file(result.words_path).text());
    expect(wordsPayload).toEqual({
      job_id: "job-1",
      segment_id: "seg-1",
      timing: {
        status: "available",
        source: "whisper-cli",
      },
      words: [
        { index: 0, word: "Hello", start: 0.1, end: 0.4 },
        { index: 1, word: "daemon.", start: 1.6, end: 2.2, confidence: 0.92 },
      ],
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("VoiceLayer Qwen3 adapter can synthesize punctuation chunks and assemble explicit pauses", async () => {
  const dataDir = createTempDir();
  const fetchTexts: string[] = [];
  let assembledChunks: Array<{ audioPath: string; pauseAfterSeconds: number }> = [];
  const fetchMock = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    fetchTexts.push(body.text);
    return new Response(
      JSON.stringify({
        audio_b64: Buffer.from(`audio:${body.text}`).toString("base64"),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const result = await renderSegment(
      "seg-1",
      {
        title: "Intro",
        script: "First sentence. Second sentence, with a clause.",
      },
      {
        artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
        dataDir,
        jobId: "job-1",
        voiceProfile: "neutral-reader",
        fetch: fetchMock,
      },
      {
        daemon_url: "http://127.0.0.1:8880",
        auth_token: "test-token",
        reference_clip: "/tmp/public-placeholder.wav",
        reference_text: "placeholder reference text",
        pause_strategy: "punctuation",
        max_utterance_words: 6,
        sentence_pause_seconds: 0.6,
        comma_pause_seconds: 0.2,
        audio_duration_probe: async () => 4.4,
        audio_assembler: async ({ chunks, outputPath }) => {
          assembledChunks = chunks;
          await writeFile(outputPath, "assembled audio", "utf8");
        },
      },
    );

    expect(fetchTexts).toEqual(["First sentence.", "Second sentence,", "with a clause."]);
    expect(assembledChunks.map((chunk) => chunk.pauseAfterSeconds)).toEqual([0.6, 0.2, 0]);
    expect(assembledChunks.every((chunk) => chunk.audioPath.endsWith(".mp3"))).toBe(true);
    expect(await Bun.file(result.audio_path).text()).toBe("assembled audio");
    expect(result.duration_seconds).toBe(4.4);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("VoiceLayer Qwen3 adapter rejects runaway generated chunks before assembly", async () => {
  const dataDir = createTempDir();
  const fetchTexts: string[] = [];
  const fetchMock = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    fetchTexts.push(body.text);
    return new Response(
      JSON.stringify({
        audio_b64: Buffer.from(`audio:${body.text}`).toString("base64"),
        audio_duration_ms: fetchTexts.length === 1 ? 327_680 : 1_500,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    await expect(
      renderSegment(
        "phase-zero-decision",
        {
          title: "Phase Zero",
          script: "Phase zero made one concrete decision: continue with a clean branch.",
        },
        {
          artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
          dataDir,
          jobId: "job-1",
          voiceProfile: "theo-local",
          fetch: fetchMock,
        },
        {
          daemon_url: "http://127.0.0.1:8880",
          auth_token: "test-token",
          reference_clip: "/tmp/public-placeholder.wav",
          reference_text: "placeholder reference text",
          pause_strategy: "punctuation",
          max_utterance_words: 24,
          sentence_pause_seconds: 0.45,
          comma_pause_seconds: 0.16,
          max_chunk_retries: 0,
          trim_silence: true,
          audio_postprocessor: async ({ inputPath, outputPath }) => {
            await Bun.write(outputPath, await Bun.file(inputPath).arrayBuffer());
          },
          audio_duration_probe: async () => 327.68,
          audio_assembler: async ({ outputPath }) => {
            await writeFile(outputPath, "assembled audio", "utf8");
          },
        },
      ),
    ).rejects.toThrow("runaway generated chunk");

    expect(fetchTexts[0]).toBe("Phase zero made one concrete decision:");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("VoiceLayer Qwen3 adapter retries a runaway generated chunk before failing the segment", async () => {
  const dataDir = createTempDir();
  const fetchTexts: string[] = [];
  const fetchMock = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    fetchTexts.push(body.text);
    return new Response(
      JSON.stringify({
        audio_b64: Buffer.from(`audio:${body.text}:${fetchTexts.length}`).toString("base64"),
        audio_duration_ms: fetchTexts.length === 1 ? 327_680 : 1_500,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const result = await renderSegment(
      "phase-zero-decision",
      {
        title: "Phase Zero",
        script: "Phase zero made one concrete decision: continue with a clean branch.",
      },
      {
        artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
        dataDir,
        jobId: "job-1",
        voiceProfile: "theo-local",
        fetch: fetchMock,
      },
      {
        daemon_url: "http://127.0.0.1:8880",
        auth_token: "test-token",
        reference_clip: "/tmp/public-placeholder.wav",
        reference_text: "placeholder reference text",
        pause_strategy: "punctuation",
        max_utterance_words: 24,
        sentence_pause_seconds: 0.45,
        comma_pause_seconds: 0.16,
        trim_silence: true,
        audio_postprocessor: async ({ inputPath, outputPath }) => {
          await Bun.write(outputPath, await Bun.file(inputPath).arrayBuffer());
        },
        audio_duration_probe: async (audioPath) => (audioPath.includes(".retry-1.") ? 1.5 : 327.68),
        audio_assembler: async ({ outputPath }) => {
          await writeFile(outputPath, "assembled audio", "utf8");
        },
      },
    );

    expect(fetchTexts.slice(0, 2)).toEqual([
      "Phase zero made one concrete decision:",
      "Phase zero made one concrete decision:",
    ]);
    expect(result.status).toBe("rendered");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("VoiceLayer Qwen3 adapter cleans audio before duration probing and alignment", async () => {
  const dataDir = createTempDir();
  const cleanedInputs: string[] = [];
  let probedPath = "";
  let alignedPath = "";
  const fetchMock = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        audio_b64: Buffer.from("raw audio").toString("base64"),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

  try {
    const result = await renderSegment(
      "seg-1",
      {
        title: "Intro",
        script: "Short sentence.",
      },
      {
        artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
        dataDir,
        jobId: "job-1",
        voiceProfile: "neutral-reader",
        fetch: fetchMock,
      },
      {
        daemon_url: "http://127.0.0.1:8880",
        auth_token: "test-token",
        reference_clip: "/tmp/public-placeholder.wav",
        reference_text: "placeholder reference text",
        trim_silence: true,
        audio_postprocessor: async ({ inputPath, outputPath }) => {
          cleanedInputs.push(inputPath);
          await writeFile(outputPath, "clean audio", "utf8");
        },
        audio_duration_probe: async (audioPath) => {
          probedPath = audioPath;
          return 1.8;
        },
        word_timing_provider: async ({ audioPath }) => {
          alignedPath = audioPath;
          return [{ index: 0, word: "Short", start: 0, end: 0.5 }];
        },
      },
    );

    expect(cleanedInputs).toHaveLength(1);
    expect(await Bun.file(result.audio_path).text()).toBe("clean audio");
    expect(probedPath).toBe(result.audio_path);
    expect(alignedPath).toBe(result.audio_path);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

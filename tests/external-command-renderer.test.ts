import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { renderSegment } from "../src/renderers/external-command.js";
import type { NormalizedNarrationJob } from "../src/schema.js";

function createTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "narrationlayer-external-renderer-"));
}

test("external-command renderer expands placeholders and emits estimated word timings", async () => {
  const dataDir = createTempDir();
  try {
    const artifactsDir = path.join(dataDir, "jobs", "job-123", "artifacts");
    const markerPath = path.join(dataDir, "runner-marker.txt");
    const runnerPath = path.join(dataDir, "runner.js");
    writeFileSync(
      runnerPath,
      [
        "const fs = require('node:fs');",
        "const [outputPath, markerPath, script, referenceClip, durationSeconds] = process.argv.slice(2);",
        "fs.writeFileSync(outputPath, 'external audio placeholder');",
        "fs.writeFileSync(markerPath, JSON.stringify({ script, referenceClip, durationSeconds }));",
      ].join("\n"),
    );

    const job: NormalizedNarrationJob = {
      job_id: "job-123",
      created_at: "2026-06-12T00:00:00.000Z",
      voice_profile: "f5-local",
      renderer: "external-command",
      segments: [
        {
          id: "seg-1",
          title: "Intro",
          script: "Measured pacing matters.",
          duration_seconds: 3,
        },
      ],
    };

    const result = await renderSegment(
      "seg-1",
      job.segments[0],
      {
        artifactsDir,
        dataDir,
        jobId: job.job_id,
        voiceProfile: job.voice_profile,
      },
      {
        command: process.execPath,
        args: [runnerPath, "{output_path}", markerPath, "{script}", "{reference_clip}", "{duration_seconds}"],
        reference_clip: "/private/reference.wav",
        timing_backend: "estimated",
      },
    );

    expect(result).toMatchObject({
      id: "seg-1",
      status: "rendered",
      duration_seconds: 3,
    });
    expect(result.audio_path).toEndWith("seg-1.wav");
    expect(JSON.parse(await Bun.file(markerPath).text())).toEqual({
      script: "Measured pacing matters.",
      referenceClip: "/private/reference.wav",
      durationSeconds: "3",
    });

    const wordsPayload = JSON.parse(await Bun.file(result.words_path).text());
    expect(wordsPayload).toMatchObject({
      job_id: "job-123",
      segment_id: "seg-1",
      timing: {
        status: "available",
        source: "estimated",
      },
      words: [
        { index: 0, word: "Measured", start: 0, end: 1 },
        { index: 1, word: "pacing", start: 1, end: 2 },
        { index: 2, word: "matters.", start: 2, end: 3 },
      ],
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("external-command renderer fails if the runner does not create audio", async () => {
  const dataDir = createTempDir();
  try {
    const artifactsDir = path.join(dataDir, "jobs", "job-123", "artifacts");
    const job: NormalizedNarrationJob = {
      job_id: "job-123",
      created_at: "2026-06-12T00:00:00.000Z",
      voice_profile: "broken-local",
      renderer: "external-command",
      segments: [{ id: "seg-1", title: "Intro", script: "Hello", duration_seconds: 1 }],
    };

    await expect(
      renderSegment(
        "seg-1",
        job.segments[0],
        { artifactsDir, dataDir, jobId: job.job_id, voiceProfile: job.voice_profile },
        {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      ),
    ).rejects.toThrow("did not create expected audio");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("external-command renderer can expand reference text loaded from a private file", async () => {
  const dataDir = createTempDir();
  try {
    const artifactsDir = path.join(dataDir, "jobs", "job-123", "artifacts");
    const referenceTextPath = path.join(dataDir, "reference.txt");
    const markerPath = path.join(dataDir, "reference-marker.txt");
    const runnerPath = path.join(dataDir, "runner.js");
    writeFileSync(referenceTextPath, "exact reference transcript");
    writeFileSync(
      runnerPath,
      [
        "const fs = require('node:fs');",
        "const [outputPath, markerPath, referenceText, referenceTextPath] = process.argv.slice(2);",
        "fs.writeFileSync(outputPath, 'external audio placeholder');",
        "fs.writeFileSync(markerPath, JSON.stringify({ referenceText, referenceTextPath }));",
      ].join("\n"),
    );
    const job: NormalizedNarrationJob = {
      job_id: "job-123",
      created_at: "2026-06-12T00:00:00.000Z",
      voice_profile: "external-local",
      renderer: "external-command",
      segments: [{ id: "seg-1", title: "Intro", script: "Hello", duration_seconds: 1 }],
    };

    await renderSegment(
      "seg-1",
      job.segments[0],
      { artifactsDir, dataDir, jobId: job.job_id, voiceProfile: job.voice_profile },
      {
        command: process.execPath,
        args: [runnerPath, "{output_path}", markerPath, "{reference_text}", "{reference_text_path}"],
        reference_text_path: referenceTextPath,
      },
    );

    expect(JSON.parse(await Bun.file(markerPath).text())).toEqual({
      referenceText: "exact reference transcript",
      referenceTextPath,
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("external-command renderer prefers measured audio duration over requested duration", async () => {
  const dataDir = createTempDir();
  try {
    const artifactsDir = path.join(dataDir, "jobs", "job-123", "artifacts");
    const runnerPath = path.join(dataDir, "runner.js");
    writeFileSync(
      runnerPath,
      [
        "const fs = require('node:fs');",
        "const [outputPath] = process.argv.slice(2);",
        "fs.writeFileSync(outputPath, 'external audio placeholder');",
      ].join("\n"),
    );
    const job: NormalizedNarrationJob = {
      job_id: "job-123",
      created_at: "2026-06-12T00:00:00.000Z",
      voice_profile: "external-local",
      renderer: "external-command",
      segments: [{ id: "seg-1", title: "Intro", script: "Hello", duration_seconds: 3 }],
    };

    const result = await renderSegment(
      "seg-1",
      job.segments[0],
      { artifactsDir, dataDir, jobId: job.job_id, voiceProfile: job.voice_profile },
      {
        command: process.execPath,
        args: [runnerPath, "{output_path}"],
        audio_duration_probe: async () => 3.25,
      },
    );

    expect(result.duration_seconds).toBe(3.25);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

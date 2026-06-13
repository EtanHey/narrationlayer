import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { renderSegment } from "../src/renderers/fake.js";
import type { NormalizedNarrationJob } from "../src/schema.js";

function createTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "narrationlayer-fake-renderer-"));
}

test("fake renderer emits dashboard word timings with start and end seconds", async () => {
  const dataDir = createTempDir();
  try {
    const artifactsDir = path.join(dataDir, "jobs", "job-123", "artifacts");
    const job: NormalizedNarrationJob = {
      job_id: "job-123",
      created_at: "2026-06-12T00:00:00.000Z",
      voice_profile: "neutral-reader",
      renderer: "fake",
      segments: [
        {
          id: "seg-1",
          title: "Intro",
          script: "Alpha beta",
          duration_seconds: 2,
        },
      ],
    };

    const result = await renderSegment("seg-1", job.segments[0], job, {
      artifactsDir,
      dataDir,
    });
    const wordsPayload = JSON.parse(await Bun.file(result.words_path).text());

    expect(wordsPayload).toMatchObject({
      job_id: "job-123",
      segment_id: "seg-1",
      timing: {
        status: "available",
        source: "fake",
      },
      words: [
        { index: 0, word: "Alpha", start: 0, end: 1 },
        { index: 1, word: "beta", start: 1, end: 2 },
      ],
    });
    expect(wordsPayload.words[0]).not.toHaveProperty("start_seconds");
    expect(wordsPayload.words[0]).not.toHaveProperty("end_seconds");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

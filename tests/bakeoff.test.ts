import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { createBakeoffJobsFromFile, parseBakeoffSpec } from "../src/bakeoff.js";

function createTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "narrationlayer-bakeoff-"));
}

test("bakeoff spec expands shared segments into one job per candidate", () => {
  const spec = parseBakeoffSpec({
    bakeoff_id: "theo-local-v1",
    candidates: [
      { id: "qwen-current", voice_profile: "theo-qwen-current", renderer: "voicelayer-qwen3" },
      { id: "f5-mlx", voice_profile: "theo-f5-mlx", renderer: "external-command" },
    ],
    segments: [
      {
        id: "punctuation",
        title: "Punctuation",
        script: "This pauses. Then it breathes.",
        duration_seconds: 4,
      },
    ],
  });

  expect(spec.jobs).toEqual([
    {
      candidate_id: "qwen-current",
      job: {
        job_id: "theo-local-v1-qwen-current",
        voice_profile: "theo-qwen-current",
        renderer: "voicelayer-qwen3",
        segments: [
          {
            id: "punctuation",
            title: "Punctuation",
            script: "This pauses. Then it breathes.",
            duration_seconds: 4,
          },
        ],
      },
    },
    {
      candidate_id: "f5-mlx",
      job: {
        job_id: "theo-local-v1-f5-mlx",
        voice_profile: "theo-f5-mlx",
        renderer: "external-command",
        segments: [
          {
            id: "punctuation",
            title: "Punctuation",
            script: "This pauses. Then it breathes.",
            duration_seconds: 4,
          },
        ],
      },
    },
  ]);
});

test("bakeoff create writes jobs and preserves candidate mapping", async () => {
  const dataDir = createTempDir();
  try {
    const specPath = path.join(dataDir, "bakeoff.json");
    writeFileSync(
      specPath,
      JSON.stringify(
        {
          bakeoff_id: "local-smoke",
          candidates: [
            { id: "current", voice_profile: "neutral-reader", renderer: "fake" },
            { id: "command", voice_profile: "command-reader", renderer: "external-command" },
          ],
          segments: [{ id: "seg-1", title: "Smoke", script: "Bakeoff jobs are explicit." }],
        },
        null,
        2,
      ),
    );

    const result = await createBakeoffJobsFromFile(specPath, dataDir);

    expect(result.bakeoff_id).toBe("local-smoke");
    expect(result.created_jobs).toHaveLength(2);
    expect(result.created_jobs.map((job) => job.candidate_id)).toEqual(["current", "command"]);

    const storedCommandJob = JSON.parse(await Bun.file(result.created_jobs[1].job_path).text());
    expect(storedCommandJob).toMatchObject({
      job_id: "local-smoke-command",
      renderer: "external-command",
      voice_profile: "command-reader",
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

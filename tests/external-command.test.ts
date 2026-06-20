import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { renderSegment } from "../src/renderers/external-command.js";
import type { NormalizedNarrationJob } from "../src/schema.js";

function createTempDir(): string {
  return mkdtempSync(
    path.join(os.tmpdir(), "narrationlayer-external-normalize-"),
  );
}

test("external-command renderer normalizes the script before invoking the command", async () => {
  const dataDir = createTempDir();
  try {
    const artifactsDir = path.join(dataDir, "jobs", "job-123", "artifacts");
    const markerPath = path.join(dataDir, "runner-marker.txt");
    const runnerPath = path.join(dataDir, "runner.js");
    writeFileSync(
      runnerPath,
      [
        "const fs = require('node:fs');",
        "const [outputPath, markerPath, script] = process.argv.slice(2);",
        "fs.writeFileSync(outputPath, 'external audio placeholder');",
        "fs.writeFileSync(markerPath, JSON.stringify({ script }));",
      ].join("\n"),
    );

    const job: NormalizedNarrationJob = {
      job_id: "job-123",
      created_at: "2026-06-12T00:00:00.000Z",
      voice_profile: "external-local",
      renderer: "external-command",
      segments: [
        {
          id: "seg-1",
          title: "Intro",
          script: "Check the pgid then run triage.",
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
        args: [runnerPath, "{output_path}", markerPath, "{script}"],
        timing_backend: "none",
      },
    );

    // The script passed to the external command is normalized for speech.
    expect(JSON.parse(await Bun.file(markerPath).text())).toEqual({
      script: "Check the P G I D then run tree azh.",
    });
    // The stored manifest also reflects the normalized script.
    expect(result.script).toBe("Check the P G I D then run tree azh.");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

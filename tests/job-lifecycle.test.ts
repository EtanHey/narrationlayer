import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { createJobFromPayload, renderJob } from "../src/service.js";
import { getManifest, getStatus } from "../src/job-store.js";

function createTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "narrationlayer-lifecycle-"));
}

test("failed renders write stable failed status and segment-level error", async () => {
  const dataDir = createTempDir();
  try {
    await createJobFromPayload(
      {
        job_id: "failed-job-1",
        voice_profile: "missing-private-profile",
        renderer: "voicelayer-qwen3",
        segments: [{ id: "seg-1", title: "Intro", script: "This should fail without config." }],
      },
      dataDir,
    );

    await expect(renderJob("failed-job-1", dataDir, { qwen: {}, external: {} })).rejects.toThrow(
      "voicelayer-qwen3 requires auth_token",
    );

    const status = await getStatus("failed-job-1", dataDir);
    expect(status).toMatchObject({
      job_id: "failed-job-1",
      status: "failed",
      progress: {
        completed_segments: 1,
        total_segments: 1,
      },
    });
    expect(status?.errors[0]).toContain("Segment seg-1:");

    const manifest = await getManifest("failed-job-1", dataDir);
    expect(manifest?.segments[0]).toMatchObject({
      id: "seg-1",
      status: "failed",
      error: expect.stringContaining("Segment seg-1:"),
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

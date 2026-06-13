import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { handleMcpToolCall } from "../src/mcp-server.js";

function createTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "narrationlayer-mcp-"));
}

function parseMcpText<T = Record<string, unknown>>(result: Record<string, unknown>): T {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as T;
}

test("MCP handlers create, render, poll status, fetch result, and list jobs", async () => {
  const previousDataDir = process.env.NARRATIONLAYER_DATA_DIR;
  const dataDir = createTempDir();
  process.env.NARRATIONLAYER_DATA_DIR = dataDir;

  try {
    const created = parseMcpText(
      await handleMcpToolCall("create_narration_job", {
        job: {
          job_id: "mcp-job-1",
          voice_profile: "neutral-reader",
          renderer: "fake",
          segments: [
            {
              id: "seg-1",
              title: "Intro",
              script: "MCP can start rendering jobs.",
              duration_seconds: 2,
            },
          ],
        },
      }),
    );
    expect(created.job_id).toBe("mcp-job-1");

    const rendered = parseMcpText<{ status: { status: string }; manifest: unknown }>(
      await handleMcpToolCall("render_narration_job", { job_id: "mcp-job-1" }),
    );
    expect(rendered.status.status).toBe("done");
    expect(rendered.manifest).toMatchObject({
      job_id: "mcp-job-1",
      segments: [{ id: "seg-1", status: "rendered" }],
    });

    const status = parseMcpText<{ status: { status: string }; done: boolean }>(
      await handleMcpToolCall("get_narration_status", { job_id: "mcp-job-1" }),
    );
    expect(status.status.status).toBe("done");
    expect(status.done).toBe(true);

    const result = parseMcpText(await handleMcpToolCall("get_narration_result", { job_id: "mcp-job-1" }));
    expect(result.job).toMatchObject({ job_id: "mcp-job-1" });
    expect(result.manifest).toMatchObject({ job_id: "mcp-job-1" });

    const listed = parseMcpText(await handleMcpToolCall("list_narration_jobs", {}));
    expect(listed.jobs).toEqual(["mcp-job-1"]);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.NARRATIONLAYER_DATA_DIR;
    } else {
      process.env.NARRATIONLAYER_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

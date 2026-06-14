import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { createJobFromPayload, renderJob } from "../src/service.js";
import { createDashboardDemo } from "../src/dashboard.js";

// The audio URL base must be configurable so a V4 listen-through dashboard can
// serve audio over a RANGE-CAPABLE HTTP server (Accept-Ranges / 206) instead of
// file://. Without ranges the browser's audio.seekable is empty and word-click
// seeking / scrubbing cannot work — so HTTP serving REQUIRES range support.

async function buildDashboard(
  audioBaseUrl: string | undefined,
): Promise<string> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "nl-audiourl-"));
  await createJobFromPayload(
    {
      job_id: "audio-url-job",
      voice_profile: "neutral-reader",
      renderer: "fake",
      segments: [
        {
          id: "seg-1",
          title: "Intro",
          script: "Hello world here.",
          duration_seconds: 3,
        },
      ],
    },
    dataDir,
  );
  await renderJob("audio-url-job", dataDir);
  const htmlPath = await createDashboardDemo(
    "audio-url-job",
    dataDir,
    audioBaseUrl ? { audioBaseUrl } : undefined,
  );
  const html = await Bun.file(htmlPath).text();
  rmSync(dataDir, { recursive: true, force: true });
  return html;
}

test("default audio_url stays file:// (back-compatible)", async () => {
  const html = await buildDashboard(undefined);
  expect(html).toContain("file://");
  expect(html).toContain("seg-1.mp3");
});

test("audioBaseUrl produces an HTTP url joined to the audio basename", async () => {
  const html = await buildDashboard("https://cdn.example.com/audio");
  expect(html).toContain("https://cdn.example.com/audio/seg-1.mp3");
  expect(html).not.toContain("file://");
});

test("audioBaseUrl trailing slash does not double up", async () => {
  const html = await buildDashboard("https://cdn.example.com/audio/");
  expect(html).toContain("https://cdn.example.com/audio/seg-1.mp3");
  expect(html).not.toContain("audio//seg-1.mp3");
});

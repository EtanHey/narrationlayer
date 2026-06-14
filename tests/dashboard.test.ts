import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { createJobFromPayload, renderJob } from "../src/service.js";
import { createDashboardDemo } from "../src/dashboard.js";

function createTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "narrationlayer-dashboard-"));
}

test("dashboard demo embeds manifest audio and teleprompter word timings", async () => {
  const dataDir = createTempDir();
  try {
    await createJobFromPayload(
      {
        job_id: "dashboard-job-1",
        voice_profile: "neutral-reader",
        renderer: "fake",
        segments: [
          {
            id: "seg-1",
            title: "Intro",
            script: "Agent dashboards can replay narration.",
            duration_seconds: 4,
          },
        ],
      },
      dataDir,
    );
    await renderJob("dashboard-job-1", dataDir);

    const outputPath = await createDashboardDemo("dashboard-job-1", dataDir);
    const html = await Bun.file(outputPath).text();

    expect(html).toContain("Agent Narration Dashboard");
    expect(html).toContain("teleprompter");
    expect(html).toContain("Agent dashboards can replay narration.");
    expect(html).toContain("audio_path");
    expect(html).toContain("words");
    expect(html).toContain("estimateWords");
    expect(html).toContain("seekToWord");
    expect(html).toContain('id="scrubber"');
    expect(html).toContain('type="range"');
    expect(html).toContain('id="previous-segment"');
    expect(html).toContain('id="next-segment"');
    expect(html).toContain("function jumpToSegment");
    expect(html).toContain("document.addEventListener(\"keydown\"");
    expect(html).toContain("scrubber.addEventListener(\"input\"");
    expect(html).toContain("audio.addEventListener(\"timeupdate\", updateScrubberFromAudio)");
    expect(html).toContain("const wasPlaying = !audio.paused");
    expect(html).toContain("audio.currentTime = clamped");
    expect(html).toContain('node.addEventListener("click", seekToWord)');
    expect(html).toContain("play-all");
    expect(html).toContain("function playAll");
    expect(html).toContain('audio.addEventListener("ended"');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

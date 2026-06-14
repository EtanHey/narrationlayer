import { expect, test } from "bun:test";

import {
  renderTeleprompterMarkup,
  teleprompterRuntimeScript,
  teleprompterStyles,
  type TeleprompterPayload,
} from "../src/teleprompter.js";

function payload(audioUrl: string): TeleprompterPayload {
  return {
    manifest: {
      job_id: "tp-job",
      created_at: "2026-06-14T00:00:00.000Z",
      voice_profile: "neutral-reader",
      renderer: "fake",
      segments: [],
      total_duration_seconds: 3,
      artifacts_dir: "/tmp/tp",
      errors: [],
    } as unknown as TeleprompterPayload["manifest"],
    segments: [
      {
        id: "seg-1",
        title: "Intro",
        script: "Hello world.",
        audio_path: "/tmp/tp/seg-1.mp3",
        audio_url: audioUrl,
        duration_seconds: 3,
        words: {
          job_id: "tp-job",
          segment_id: "seg-1",
          timing: { status: "available", source: "fake" },
          words: [{ index: 0, word: "Hello", start: 0, end: 1.5 }],
        },
        words_path: "/tmp/tp/words.json",
      },
    ],
  };
}

test("module emits portable styles, markup, and embedded payload", () => {
  const markup = renderTeleprompterMarkup(
    payload("https://cdn.example.test/seg-1.mp3"),
  );
  const styles = teleprompterStyles();
  expect(markup).toContain(
    '<script id="dashboard-data" type="application/json">',
  );
  expect(markup).toContain('class="teleprompter"');
  expect(markup).toContain("https://cdn.example.test/seg-1.mp3"); // audio_url comes from payload
  expect(styles).toContain(".teleprompter");
  expect(styles).toContain(".word.active");
  expect(styles).toContain("overflow-y: auto"); // teleprompter is a scroll container
});

test("runtime carries the full verified backbone, not the old baseline", () => {
  const s = teleprompterRuntimeScript();
  // the 5 base behaviors
  expect(s).toContain("function jumpToSegment");
  expect(s).toContain("function seekToWord");
  expect(s).toContain('document.addEventListener("keydown"');
  expect(s).toContain('scrubber.addEventListener("input"');
  // the hardening that the old item8 module lacked
  expect(s).toContain("let scrubbing = false"); // drag-jitter guard
  expect(s).toContain("const segmentChanged ="); // jumpTo SEEKS, never restarts
  expect(s).toContain("keep position, do not restart");
  expect(s).toContain("scrollIntoView"); // active-word auto-scroll
  // no source-of-truth leakage / timer hacks
  expect(s).not.toContain("file://");
  expect(s).not.toContain("setTimeout");
});

test("module output is deterministic", () => {
  expect(teleprompterRuntimeScript()).toBe(teleprompterRuntimeScript());
  expect(teleprompterStyles()).toBe(teleprompterStyles());
  const a = renderTeleprompterMarkup(payload("file:///x/seg-1.mp3"));
  const b = renderTeleprompterMarkup(payload("https://cdn/seg-1.mp3"));
  expect(a.replace("file:///x/seg-1.mp3", "https://cdn/seg-1.mp3")).toBe(b);
});

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { type RenderManifestSegment, type WordTiming, type NormalizedNarrationJob, type WordsFile } from "../schema.js";
import { getWordsFromScript } from "./voicelayer-qwen3.js";
import type { RenderSegmentOptions } from "./types.js";

function estimateDurationFromWords(wordCount: number): number {
  // 150 WPM ~= 2.5 words/sec, then rounded to 0.01 precision.
  const safeWordCount = Math.max(wordCount, 1);
  return Number((safeWordCount / 2.5).toFixed(2));
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function writeFallbackWords(durationSeconds: number): WordTiming[] {
  const words = ["[segment]", "has", "no", "script", "text"];
  const unit = durationSeconds / words.length;
  let cursor = 0;
  return words.map((word, index) => {
    const start = cursor;
    const end = cursor + unit;
    cursor = end;
    return {
      index,
      word,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    };
  });
}

export async function renderSegment(
  segmentId: string,
  segment: { title: string; script: string; duration_seconds?: number },
  job: NormalizedNarrationJob,
  options: RenderSegmentOptions,
): Promise<RenderManifestSegment> {
  const artifactsRoot = path.join(options.artifactsDir, "segments", segmentId);
  await mkdir(artifactsRoot, { recursive: true });

  const words = getWordsFromScript(segment.script);
  const durationSeconds = clampNonNegative(segment.duration_seconds ?? estimateDurationFromWords(words.length));

  const audioPath = path.join(artifactsRoot, `${segmentId}.mp3`);
  const wordsPath = path.join(artifactsRoot, "words.json");
  const normalizedWords = words.length
    ? words.map((word, index) => {
      const start = durationSeconds * (index / words.length);
      const end = durationSeconds * ((index + 1) / words.length);
      return {
        index,
        word,
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
      };
    })
    : writeFallbackWords(durationSeconds);

  const wordsPayload: WordsFile = {
    job_id: job.job_id,
    segment_id: segmentId,
    timing: {
      status: "available",
      source: "fake",
    },
    words: normalizedWords,
  };

  await writeFile(audioPath, "placeholder fake narration audio", "utf8");
  await writeFile(wordsPath, JSON.stringify(wordsPayload, null, 2), "utf8");

  const manifestSegment: RenderManifestSegment = {
    id: segmentId,
    title: segment.title,
    script: segment.script,
    audio_path: audioPath,
    duration_seconds: durationSeconds,
    words_path: wordsPath,
    status: "rendered",
  };

  return manifestSegment;
}

import { expect, test } from "bun:test";

import { wordsFromWhisperJson } from "../src/word-timings.js";

test("Whisper token timestamps merge subword tokens and punctuation into word timings", () => {
  const words = wordsFromWhisperJson({
    transcription: [
      {
        tokens: [
          { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.99 },
          { text: " tele", offsets: { from: 15610, to: 15810 }, p: 0.9 },
          { text: "pr", offsets: { from: 15810, to: 15910 }, p: 0.91 },
          { text: "omp", offsets: { from: 15910, to: 16060 }, p: 0.92 },
          { text: "ter", offsets: { from: 16060, to: 16110 }, p: 0.93 },
          { text: ".", offsets: { from: 16110, to: 16200 }, p: 0.95 },
          { text: "[_TT_365]", offsets: { from: 16200, to: 16200 }, p: 0.1 },
        ],
      },
    ],
  });

  expect(words).toEqual([
    {
      index: 0,
      word: "teleprompter.",
      start: 15.61,
      end: 16.2,
      confidence: 0.922,
    },
  ]);
});

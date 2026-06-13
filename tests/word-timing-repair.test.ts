import { expect, test } from "bun:test";

import { normalizeWordTimingsForScript } from "../src/word-timing-repair.js";

test("timing repair falls back to script words when Whisper hears a bad chunk boundary", () => {
  const result = normalizeWordTimingsForScript(
    "I changed NarrationLayer so punctuation is enforced by audio.",
    [
      { index: 0, word: "I", start: 0.07, end: 0.07 },
      { index: 1, word: "changed", start: 0.24, end: 0.56 },
      { index: 2, word: "narration", start: 0.56, end: 1.19 },
      { index: 3, word: "layer", start: 1.19, end: 1.56 },
      { index: 4, word: "so", start: 1.56, end: 1.79 },
      { index: 5, word: "punctuation", start: 1.8, end: 2.44 },
      { index: 6, word: "is", start: 2.44, end: 2.53 },
      { index: 7, word: "enforced.", start: 2.53, end: 3.08 },
      { index: 8, word: "Bye.", start: 3.32, end: 4.71 },
      { index: 9, word: "Audio.", start: 5.04, end: 5.3 },
    ],
    5.69,
  );

  expect(result.repaired).toBe(true);
  expect(result.reason).toBe("word_mismatch");
  expect(result.words.map((word) => word.word)).toEqual([
    "I",
    "changed",
    "NarrationLayer",
    "so",
    "punctuation",
    "is",
    "enforced",
    "by",
    "audio.",
  ]);
  expect(result.words.at(-1)?.end).toBe(5.69);
});

test("timing repair replaces suspicious zero-length Whisper timings", () => {
  const result = normalizeWordTimingsForScript(
    "The teleprompter follows that final audio.",
    [
      { index: 0, word: "The", start: 0.27, end: 0.27 },
      { index: 1, word: "teleprompter", start: 0.31, end: 1.35 },
      { index: 2, word: "follows", start: 1.35, end: 1.96 },
      { index: 3, word: "that", start: 1.99, end: 2.34 },
      { index: 4, word: "final", start: 2.34, end: 2.49 },
      { index: 5, word: "audio.", start: 3.25, end: 3.28 },
    ],
    3.28,
  );

  expect(result.repaired).toBe(true);
  expect(result.reason).toBe("suspicious_timing");
  expect(result.words[0].start).toBe(0);
  expect(result.words.every((word) => word.end - word.start >= 0.1)).toBe(true);
  expect(result.words.at(-1)?.end).toBe(3.28);
});

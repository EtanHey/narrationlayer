import { expect, test } from "bun:test";

import { normalizeWordTimingsForScript } from "../src/word-timing-repair.js";

test("timing repair aligns split Whisper words to clean script words without even-splitting", () => {
  const result = normalizeWordTimingsForScript(
    "NarrationLayer ships one-line gates.",
    [
      { index: 0, word: "narration", start: 0.12, end: 0.34 },
      { index: 1, word: "layer", start: 0.34, end: 0.62 },
      { index: 2, word: "ships", start: 0.91, end: 1.08 },
      { index: 3, word: "one", start: 1.23, end: 1.39 },
      { index: 4, word: "line", start: 1.39, end: 1.74 },
      { index: 5, word: "gates.", start: 2.02, end: 2.41 },
    ],
    3,
  );

  expect(result.repaired).toBe(true);
  expect(result.reason).toBe("word_mismatch");
  expect(result.words.map((word) => word.word)).toEqual([
    "NarrationLayer",
    "ships",
    "one-line",
    "gates.",
  ]);
  expect(result.words[0]).toMatchObject({
    word: "NarrationLayer",
    start: 0.12,
    end: 0.62,
  });
  expect(result.words[2]).toMatchObject({
    word: "one-line",
    start: 1.23,
    end: 1.74,
  });
  expect(new Set(result.words.map((word) => Number((word.end - word.start).toFixed(3)))).size).toBeGreaterThan(2);
});

test("timing repair interpolates only script words missing between real Whisper matches", () => {
  const result = normalizeWordTimingsForScript(
    "alpha missing omega",
    [
      { index: 0, word: "alpha", start: 0.5, end: 0.8 },
      { index: 1, word: "omega", start: 2, end: 2.35 },
    ],
    2.7,
  );

  expect(result.repaired).toBe(true);
  expect(result.reason).toBe("word_mismatch");
  expect(result.words).toEqual([
    { index: 0, word: "alpha", start: 0.5, end: 0.8 },
    { index: 1, word: "missing", start: 0.8, end: 2 },
    { index: 2, word: "omega", start: 2, end: 2.35 },
  ]);
});

test("timing repair uses real aligned times when Whisper hears a bad chunk boundary", () => {
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
  expect(result.words[2]).toMatchObject({
    word: "NarrationLayer",
    start: 0.56,
    end: 1.56,
  });
  expect(result.words[7]).toMatchObject({
    word: "by",
    start: 3.32,
    end: 4.71,
  });
  expect(result.words.at(-1)).toMatchObject({
    word: "audio.",
    start: 5.04,
    end: 5.3,
  });
});

test("timing repair preserves matching real Whisper timings with isolated zero-length words", () => {
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

  expect(result.repaired).toBe(false);
  expect(result.words[0]).toMatchObject({ word: "The", start: 0.27, end: 0.27 });
  expect(result.words.at(-1)?.end).toBe(3.28);
});

import { expect, test } from "bun:test";
import { MAX_BREATHING_PIECE_WORDS, splitForBreathing, splitLongPieces } from "../../src/plan/breathing.js";

// The Qwen3-TTS clone path stops a long generation at about 10 s, often mid-word, so the
// runner never sends one breathing piece longer than MAX_BREATHING_PIECE_WORDS words.

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const LONG =
  "When the build finished late on Tuesday night, the team opened the dashboard, checked every chart against the numbers from the morning, and found that the cache had quietly doubled its size without warning anyone.";

test("a long sentence is split at the clause nearest its middle, with the comma pause between", () => {
  const pieces = splitLongPieces(splitForBreathing(`${LONG} Then we left.`, 0.5, 0), 0.25);
  expect(pieces).toEqual([
    { text: "When the build finished late on Tuesday night, the team opened the dashboard,", padAfterSeconds: 0.25 },
    { text: "checked every chart against the numbers from the morning, and found that the cache had quietly doubled its size without warning anyone.", padAfterSeconds: 0.5 },
    { text: "Then we left.", padAfterSeconds: 0 },
  ]);
  expect(pieces.map((p) => p.text).join(" ")).toBe(`${LONG} Then we left.`);
});

test("no piece is longer than the limit, and short pieces are untouched", () => {
  const text = `${LONG} ${LONG.replace(/,/g, "")} Short one here.`;
  const before = splitForBreathing(text, 0.5, 0);
  const after = splitLongPieces(before, 0);
  expect(before.some((p) => words(p.text) > MAX_BREATHING_PIECE_WORDS)).toBe(true);
  for (const p of after) expect(words(p.text)).toBeLessThanOrEqual(MAX_BREATHING_PIECE_WORDS);
  expect(after.at(-1)).toEqual({ text: "Short one here.", padAfterSeconds: 0 });
  expect(after.map((p) => p.text).join(" ")).toBe(text);
});

test("without a clause mark the cut goes before a conjunction, else at the middle", () => {
  const conj = "one two three four five six seven eight nine ten and eleven twelve thirteen fourteen fifteen sixteen";
  expect(splitLongPieces([{ text: conj, padAfterSeconds: 0 }], 0.2, 10).map((p) => p.text)).toEqual([
    "one two three four five six seven eight nine ten",
    "and eleven twelve thirteen fourteen fifteen sixteen",
  ]);
  const plain = Array.from({ length: 12 }, (_, i) => `w${i}`).join(" ");
  expect(splitLongPieces([{ text: plain, padAfterSeconds: 0.5 }], 0.2, 10)).toEqual([
    { text: "w0 w1 w2 w3 w4 w5", padAfterSeconds: 0.2 },
    { text: "w6 w7 w8 w9 w10 w11", padAfterSeconds: 0.5 },
  ]);
});

test("a clause mark too near either end is not used: each side keeps five words", () => {
  const text = "Yes, one two three four five six seven eight nine ten eleven";
  const pieces = splitLongPieces([{ text, padAfterSeconds: 0 }], 0, 10);
  expect(pieces.map((p) => p.text)).toEqual(["Yes, one two three four five", "six seven eight nine ten eleven"]);
  expect(pieces.every((p) => words(p.text) >= 5)).toBe(true);
});

test("pieces keep their own whitespace: short ones as they are, split ones as slices", () => {
  const short = { text: "Release checklist\n- Ready.", padAfterSeconds: 0.5 };
  expect(splitLongPieces([short], 0)).toEqual([short]);
  const text = "one two three four five,\nsix  seven eight nine ten eleven";
  expect(splitLongPieces([{ text, padAfterSeconds: 0 }], 0.1, 10).map((p) => p.text)).toEqual([
    "one two three four five,",
    "six  seven eight nine ten eleven",
  ]);
});

test("the limit must leave room for two five-word sides", () => {
  expect(() => splitLongPieces([], 0, 9)).toThrow(RangeError);
  expect(() => splitLongPieces([], 0, 10.5)).toThrow(RangeError);
  expect(splitLongPieces([], 0, 10)).toEqual([]);
});

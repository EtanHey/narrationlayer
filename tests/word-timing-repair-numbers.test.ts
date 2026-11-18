import { expect, test } from "bun:test";

import type { WordTiming } from "../src/schema.js";
import { normalizeWordTimingsForScript } from "../src/word-timing-repair.js";

// Rule under test: a spoken number and its written form match as one block. The script words of
// that block share the recognised span, split in proportion to their letters and digits (the same
// rule as any other many-to-one match); the span's start and end are kept exactly.

function heard(words: Array<[string, number, number, number?]>): WordTiming[] {
  return words.map(([word, start, end, confidence], index) => ({
    index,
    word,
    start,
    end,
    ...(confidence === undefined ? {} : { confidence }),
  }));
}

function spans(words: WordTiming[]): Array<[string, number, number]> {
  return words.map((word) => [word.word, word.start, word.end]);
}

// M1 evidence: revendor-proof-m1/job/segments/number/words.raw.json (w131 diagnosis).
const M1_RAW = heard([
  ["The", 0.16, 0.27, 0.594],
  ["sample", 0.27, 0.81, 0.986],
  ["budget", 0.81, 1.11, 0.998],
  ["is", 1.4, 1.53, 0.997],
  ["$400", 1.53, 2.27, 0.928],
]);

test("'four hundred dollars' shares the raw '$400' span and earlier words keep raw timings", () => {
  const result = normalizeWordTimingsForScript("The sample budget is four hundred dollars.", M1_RAW, 2.48);

  expect(result.repaired).toBe(true);
  expect(result.estimated).toBe(false);
  // Weights: four 4, hundred 7, dollars 7 of 18 over 1.53-2.27 s.
  expect(spans(result.words)).toEqual([
    ["The", 0.16, 0.27],
    ["sample", 0.27, 0.81],
    ["budget", 0.81, 1.11],
    ["is", 1.4, 1.53],
    ["four", 1.53, 1.694],
    ["hundred", 1.694, 1.982],
    ["dollars.", 1.982, 2.27],
  ]);
  expect(result.words.slice(4).map((word) => word.confidence)).toEqual([0.928, 0.928, 0.928]);
});

test("a plain number: 'ninety-six' takes the raw '96' span, not the gap around it", () => {
  const result = normalizeWordTimingsForScript(
    "We passed ninety-six checks.",
    heard([
      ["We", 0.1, 0.3],
      ["passed", 0.3, 0.8],
      ["96", 1.0, 1.5],
      ["checks.", 1.7, 2.1],
    ]),
    2.3,
  );

  expect(spans(result.words)).toEqual([
    ["We", 0.1, 0.3],
    ["passed", 0.3, 0.8],
    ["ninety-six", 1.0, 1.5],
    ["checks.", 1.7, 2.1],
  ]);
});

test("a percentage: 'forty percent' shares the raw '40%' span", () => {
  const result = normalizeWordTimingsForScript(
    "Coverage rose forty percent today.",
    heard([
      ["Coverage", 0.1, 0.6],
      ["rose", 0.6, 0.9],
      ["40%", 1.0, 1.6],
      ["today.", 1.8, 2.2],
    ]),
    2.4,
  );

  // Weights: forty 5, percent 7 of 12 over 1.0-1.6 s.
  expect(spans(result.words)).toEqual([
    ["Coverage", 0.1, 0.6],
    ["rose", 0.6, 0.9],
    ["forty", 1.0, 1.25],
    ["percent", 1.25, 1.6],
    ["today.", 1.8, 2.2],
  ]);
});

test("a year: 'twenty twenty-six' shares the raw '2026' span at the end of the sentence", () => {
  const result = normalizeWordTimingsForScript(
    "It ships in twenty twenty-six.",
    heard([
      ["It", 0.1, 0.25],
      ["ships", 0.25, 0.6],
      ["in", 0.6, 0.75],
      ["2026.", 1.0, 1.75],
    ]),
    2.5,
  );

  // Weights: twenty 6, twentysix 9 of 15 over 1.0-1.75 s.
  expect(spans(result.words)).toEqual([
    ["It", 0.1, 0.25],
    ["ships", 0.25, 0.6],
    ["in", 0.6, 0.75],
    ["twenty", 1.0, 1.3],
    ["twenty-six.", 1.3, 1.75],
  ]);
});

test("a five-word number inside a longer sentence keeps every other word on its raw timing", () => {
  const before = ["After", "the", "review", "we", "raised", "the", "limit", "to"];
  const after = ["for", "every", "team", "member."];
  const at = (seconds: number) => Number(seconds.toFixed(3));
  const raw = heard([
    ...before.map((word, index): [string, number, number] => [word, at(0.1 + index * 0.3), at(0.35 + index * 0.3)]),
    ["$125", 2.6, 3.6],
    ...after.map((word, index): [string, number, number] => [word, at(3.8 + index * 0.3), at(4.05 + index * 0.3)]),
  ]);
  const result = normalizeWordTimingsForScript(
    `${before.join(" ")} one hundred and twenty-five dollars ${after.join(" ")}`,
    raw,
    5.2,
  );

  const words = spans(result.words);
  expect(words.slice(0, 8)).toEqual(spans(raw.slice(0, 8)));
  expect(words.slice(13)).toEqual(spans(raw.slice(9)));
  // Weights: one 3, hundred 7, and 3, twentyfive 10, dollars 7 of 30 over 2.6-3.6 s.
  expect(words.slice(8, 13)).toEqual([
    ["one", 2.6, 2.7],
    ["hundred", 2.7, 2.933],
    ["and", 2.933, 3.033],
    ["twenty-five", 3.033, 3.367],
    ["dollars", 3.367, 3.6],
  ]);
});

test("a real mismatch: 'four hundred dollars' is not matched to a heard '$500'", () => {
  const raw = M1_RAW.map((word) => (word.word === "$400" ? { ...word, word: "$500" } : word));
  const result = normalizeWordTimingsForScript("The sample budget is four hundred dollars.", raw, 2.48);

  // The number words are unmatched: filled evenly from "is" to the end of the audio, not given
  // the '$500' span. The words before keep their raw timings.
  expect(spans(result.words)).toEqual([
    ["The", 0.16, 0.27],
    ["sample", 0.27, 0.81],
    ["budget", 0.81, 1.11],
    ["is", 1.4, 1.53],
    ["four", 1.53, 1.847],
    ["hundred", 1.847, 2.163],
    ["dollars.", 2.163, 2.48],
  ]);
  expect(result.words.slice(4).every((word) => word.confidence === undefined)).toBe(true);
});

test("units must agree: spoken 'four hundred' is not the heard '$400'", () => {
  const result = normalizeWordTimingsForScript(
    "We counted four hundred today.",
    heard([
      ["We", 0.1, 0.3],
      ["counted", 0.3, 0.8],
      ["$400", 1.0, 1.6],
      ["today.", 1.9, 2.3],
    ]),
    2.5,
  );

  // Unmatched: filled evenly over the 0.8-1.9 s gap, not the 1.0-1.6 s '$400' span.
  expect(spans(result.words).slice(2, 4)).toEqual([
    ["four", 0.8, 1.35],
    ["hundred", 1.35, 1.9],
  ]);
});

// Symbol direction: the script writes the symbol, the recogniser heard the words.

test("script '40%' matches a heard 'forty percent' and every raw timing is kept", () => {
  const raw = heard([
    ["Growth", 0.1, 0.5],
    ["was", 0.5, 0.7],
    ["forty", 0.8, 1.1],
    ["percent", 1.1, 1.6],
    ["this", 1.7, 1.9],
    ["year.", 1.9, 2.3],
  ]);
  const result = normalizeWordTimingsForScript("Growth was 40% this year.", raw, 2.4);

  expect(result.estimated).toBe(false);
  // The script word "40" takes the whole recognised "forty percent" span; the neighbours keep theirs.
  expect(spans(result.words)).toEqual([
    ["Growth", 0.1, 0.5],
    ["was", 0.5, 0.7],
    ["40", 0.8, 1.6],
    ["this", 1.7, 1.9],
    ["year.", 1.9, 2.3],
  ]);
});

test("script '$5' matches a heard 'five dollars'", () => {
  const result = normalizeWordTimingsForScript(
    "It costs $5 today.",
    heard([
      ["It", 0.1, 0.3],
      ["costs", 0.3, 0.7],
      ["five", 0.8, 1.1],
      ["dollars", 1.1, 1.6],
      ["today.", 1.8, 2.2],
    ]),
    2.4,
  );

  expect(result.estimated).toBe(false);
  expect(spans(result.words)).toEqual([
    ["It", 0.1, 0.3],
    ["costs", 0.3, 0.7],
    ["5", 0.8, 1.6],
    ["today.", 1.8, 2.2],
  ]);
});

test("a real mismatch: script '40%' is not matched to a heard 'fifty percent'", () => {
  const result = normalizeWordTimingsForScript(
    "Growth was 40% this year.",
    heard([
      ["Growth", 0.1, 0.5],
      ["was", 0.5, 0.7],
      ["fifty", 0.8, 1.1],
      ["percent", 1.1, 1.6],
      ["this", 1.7, 1.9],
      ["year.", 1.9, 2.3],
    ]),
    2.4,
  );

  // Unmatched: filled over the 0.7-1.7 s gap, not given the heard span's own boundaries.
  expect(spans(result.words).slice(2, 3)).toEqual([["40", 0.7, 1.7]]);
});

test("a real mismatch: script '$5' is not matched to a heard 'five percent'", () => {
  const result = normalizeWordTimingsForScript(
    "It costs $5 today.",
    heard([
      ["It", 0.1, 0.3],
      ["costs", 0.3, 0.7],
      ["five", 0.8, 1.1],
      ["percent", 1.1, 1.6],
      ["today.", 1.8, 2.2],
    ]),
    2.4,
  );

  expect(spans(result.words).slice(2, 3)).toEqual([["5", 0.7, 1.8]]);
});

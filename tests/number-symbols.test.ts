import { expect, test } from "bun:test";

import { wordMismatches } from "../src/quality/take-checks.js";
import type { WordTiming } from "../src/schema.js";
import { normalizeWordTimingsForScript } from "../src/word-timing-repair.js";

// Units and signs must agree. An unknown currency or sign symbol ("€", "₪", "−" U+2212, "<") makes a
// number span non-equivalent; it is never dropped. In timing repair, a unit the script lacks
// ("400" against a voice saying "four hundred dollars") does not match either.

const words = (text: string) => text.split(" ").filter(Boolean).map((word, i) => ({ word, start: i, end: i + 1 }));

function heard(list: Array<[string, number, number]>): WordTiming[] {
  return list.map(([word, start, end], index) => ({ index, word, start, end }));
}

function lastSpan(script: string, timings: WordTiming[], duration: number): [string, number, number] {
  const last = normalizeWordTimingsForScript(script, timings, duration).words.at(-1)!;
  return [last.word, last.start, last.end];
}

// "The budget is <number>." with the number heard at 1.53-2.27 s in 2.48 s of audio. A matched
// number ends at 2.27; an unmatched one is filled from "is" (1.53) to the end of the audio (2.48).
const LEAD: Array<[string, number, number]> = [["The", 0.16, 0.27], ["budget", 0.27, 0.81], ["is", 1.4, 1.53]];
const FOUR_HUNDRED_DOLLARS: Array<[string, number, number]> = [["four", 1.53, 1.7], ["hundred", 1.7, 1.98], ["dollars.", 1.98, 2.27]];

// scriptWords() displays "€400." as "400." (unchanged here); the span is what these tests check.
test("repair: a script '€400' does not match a heard 'four hundred dollars'", () => {
  expect(lastSpan("The budget is €400.", heard([...LEAD, ...FOUR_HUNDRED_DOLLARS]), 2.48)).toEqual(["400.", 1.53, 2.48]);
});

test("repair: a script 'four hundred dollars' does not match a heard '₪400'", () => {
  expect(lastSpan("The budget is four hundred dollars.", heard([...LEAD, ["₪400.", 1.53, 2.27]]), 2.48))
    .toEqual(["dollars.", 2.163, 2.48]);
});

// A heard extra word ("Basically") keeps the word counts apart, so these reach the alignment rather
// than the existing same-count shortcut (which compares letters only and is not changed here).
const LEAD_UM: Array<[string, number, number]> = [["Basically", 0, 0.15], ...LEAD];

test("repair: a script '€400' does not match a heard '$400' (literal path)", () => {
  expect(lastSpan("The budget is €400.", heard([...LEAD_UM, ["$400.", 1.53, 2.27]]), 2.48)).toEqual(["400.", 1.53, 2.48]);
});

test("repair: the same currency still matches ('€400' / '€400')", () => {
  expect(lastSpan("The budget is €400.", heard([...LEAD_UM, ["€400.", 1.53, 2.27]]), 2.48)).toEqual(["400.", 1.53, 2.27]);
});

for (const minus of ["−5.", "-5."]) {
  test(`repair: a script '${minus}' does not match a heard 'five' or '5'`, () => {
    expect(lastSpan(`The budget is ${minus}`, heard([...LEAD, ["five.", 1.53, 2.27]]), 2.48)).toEqual(["5.", 1.53, 2.48]);
    expect(lastSpan(`The budget is ${minus}`, heard([...LEAD_UM, ["5.", 1.53, 2.27]]), 2.48)).toEqual(["5.", 1.53, 2.48]);
  });
}

test("repair: '<5' matches neither 'five' nor 'less than five'", () => {
  expect(lastSpan("The budget is <5.", heard([...LEAD, ["five.", 1.53, 2.27]]), 2.48)).toEqual(["5.", 1.53, 2.48]);
  expect(lastSpan("The budget is <5.", heard([...LEAD, ["less", 1.53, 1.7], ["than", 1.7, 1.9], ["five.", 1.9, 2.27]]), 2.48))
    .toEqual(["5.", 1.53, 2.48]);
});

test("repair: a script '400' matches only 'four hundred' of a voice saying 'four hundred dollars' (unit the script lacks)", () => {
  // "dollars." stays an extra heard word: the script number never absorbs a unit it does not have.
  expect(lastSpan("The budget is 400.", heard([...LEAD, ...FOUR_HUNDRED_DOLLARS]), 2.48)).toEqual(["400.", 1.53, 1.98]);
});

test("repair: a script '$400' still matches a heard 'four hundred dollars' and a bare heard '400'", () => {
  expect(lastSpan("The budget is $400.", heard([...LEAD, ...FOUR_HUNDRED_DOLLARS]), 2.48)).toEqual(["400.", 1.53, 2.27]);
  expect(lastSpan("The budget is four hundred dollars.", heard([...LEAD, ["400.", 1.53, 2.27]]), 2.48))
    .toEqual(["dollars.", 1.982, 2.27]);
});

test("repair: a script '40%' matches a heard 'forty percent'", () => {
  expect(lastSpan("The budget is 40%", heard([...LEAD, ["forty", 1.53, 1.8], ["percent.", 1.8, 2.27]]), 2.48))
    .toEqual(["40", 1.53, 2.27]);
});

for (const [sent, said] of [
  ["It cost €400.", "It cost four hundred dollars."],
  ["It cost four hundred dollars.", "It cost €400."],
  ["It cost ₪400.", "It cost four hundred dollars."],
  ["It cost €400.", "It cost ₪400."],
  ["It cost €400.", "It cost $400."],
  ["It fell −5.", "It fell five."],
  ["It fell -5.", "It fell five."],
  ["It fell −5.", "It fell 5."],
  ["Keep it <5.", "Keep it five."],
  ["Keep it <5.", "Keep it less than five."],
]) {
  test(`take check rejects: ${sent} / ${said}`, () => {
    expect(wordMismatches(sent, words(said), { setting: "a" }).pass).toBe(false);
  });
}

test("take check accepts the same currency and sign", () => {
  expect(wordMismatches("It cost €400.", words("It cost €400."), { setting: "a" }).pass).toBe(true);
  expect(wordMismatches("It fell −5.", words("It fell −5."), { setting: "a" }).pass).toBe(true);
});

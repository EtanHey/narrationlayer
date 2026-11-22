import { expect, test } from "bun:test";
import { wordMismatches } from "../src/quality/take-checks.js";

const words = (text: string) => text.split(" ").map((word, i) => ({ word, start: i, end: i + 1 }));
// Number words match exactly or through the number equivalence, never through the one-letter
// spelling allowance: each pair below is one letter apart and a different value (or no number).
const wrongValues: [string, string][] = [
  ["Seventy takes passed.", "Seventh takes passed."],
  ["The seventh take passed.", "The seventy take passed."],
  ["Eighty takes passed.", "Eighth takes passed."],
  ["The eighth take passed.", "The eighty take passed."],
  ["Eighty takes passed.", "Eights takes passed."],
  ["Two million users.", "Two billion users."],
  ["Two billion users.", "Two million users."],
  ["Millions of users.", "Billions of users."],
  ["The millionth user.", "The billionth user."],
  ["Thirty guests came.", "Thirsty guests came."],
  ["Eighty runners came.", "Weighty runners came."],
  ["Fourteen takes passed.", "Fourteens takes passed."],
  ["One fifteenth of the takes.", "One fifteenths of the takes."],
  ["Two hundred takes.", "Two hundreds takes."],
  // Red-team round 1 (18 Nov): hyphenated number words and "trillion" still took the allowance.
  ["Forty-eight takes passed.", "Forty-eighth takes passed."],
  ["Eighty-eight takes passed.", "Eighty-eights takes passed."],
  ["Two trillion rows.", "Two trillions rows."],
  // Red-team round 2: a trailing 's.
  ["The eighty's sound.", "The eights sound."],
];
for (const [sent, heard] of wrongValues) {
  test(`number word one letter apart fails: ${sent} / ${heard}`, () => {
    expect(wordMismatches(sent, words(heard), { setting: "a" }).pass).toBe(false);
    expect(wordMismatches(heard, words(sent), { setting: "a" }).pass).toBe(false);
  });
}

// Controls: exact number words, the number equivalence and non-number spellings still pass.
const stillEquivalent: [string, string][] = [
  ["Seventy takes passed.", "seventy takes passed."],
  ["Seventy takes passed.", "70 takes passed."],
  ["The seventh take passed.", "The 7th take passed."],
  ["Two million users.", "2,000,000 users."],
  ["Kubernetes runs.", "Kubernetis runs."],
  ["The settings work.", "The setting work."],
  // Red-team round 2: hyphenated words that are not numbers keep the allowance.
  ["A one-liner helps.", "A one-liners helps."],
  ["A second-rate take.", "A second-rated take."],
  ["A one-sided view.", "A one-side view."],
];
for (const [sent, heard] of stillEquivalent) {
  test(`number word control passes: ${sent} / ${heard}`, () => {
    expect(wordMismatches(sent, words(heard), { setting: "a" }).pass).toBe(true);
    expect(wordMismatches(heard, words(sent), { setting: "a" }).pass).toBe(true);
  });
}

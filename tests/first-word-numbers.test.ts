import { expect, test } from "bun:test";
import { firstWordOmitted } from "../src/quality/take-checks.js";

const words = (text: string) => text.split(" ").filter(Boolean).map((word, i) => ({ word, start: i, end: i + 1 }));
// The opening number was spoken, in its other form: never a first-word omission.
const heardInOtherForm: [string, string][] = [
  ["Forty percent of takes passed.", "40% of takes passed."],
  ["$400 was the budget.", "four hundred dollars was the budget."],
  ["$400 was the budget.", "four hundred was the budget."],
  ["Four hundred dollars was the budget.", "$400 was the budget."],
  ["Four hundred dollars was the budget.", "400 dollars was the budget."],
  ["Three hundred and seventy two takes passed.", "372 takes passed."],
  ["Two thousand takes passed.", "2,000 takes passed."],
  ["Twenty twenty-six was long.", "2026 was long."],
  ["A hundred takes passed.", "100 takes passed."],
  ["Seventh take passed.", "7th take passed."],
  ["7th take passed.", "seventh take passed."],
  ["1,500 takes passed.", "one thousand five hundred takes passed."],
];
for (const [sent, heard] of heardInOtherForm) {
  test(`opening number heard in its other form is not omitted: ${sent} / ${heard}`, () => {
    expect(firstWordOmitted(sent, words(heard)).omitted).toBe(false);
  });
}

// The opening number was not spoken: a real omission, even when later numbers add up to it.
const reallyOmitted: [string, string][] = [
  ["Three, two, one, go.", "two one go."],
  ["Ten, nine, go.", "nine one go."],
  ["Forty percent of takes passed.", "of takes passed."],
  ["$400 was the budget.", "was the budget."],
  ["Four hundred dollars was the budget.", "$500 was the budget."],
  ["Three moons rose.", "9 moons rose."],
];
for (const [sent, heard] of reallyOmitted) {
  test(`opening number not spoken is omitted: ${sent} / ${heard}`, () => {
    expect(firstWordOmitted(sent, words(heard)).omitted).toBe(true);
  });
}

import { expect, test } from "bun:test";
import { wordMismatches } from "../src/quality/take-checks.js";

const words = (text: string) => text.split(" ").map((word, i) => ({ word, start: i, end: i + 1 }));
const equivalent = [
  ["It cost four hundred dollars.", "It cost $400."],
  ["It cost four hundred dollars.", "It cost 400."],
  ["A hundred takes.", "100 takes."],
  ["Thirteen gigabytes on the M4.", "13 gigabytes on the M4."],
  ["Zero point five percent.", "0.5%."],
  ["Twenty five per cent.", "25%."],
  ["Analyse the organisation catalogue.", "Analyze the organization catalog."],
  ["It cost four hundred dollars.", "It cost 400 dollars."],
  ["Three hundred and seventy two takes.", "372 takes."],
  ["The colour is red.", "The color is red."],
  ["One thousand two hundred and thirty-four takes.", "1,234 takes."],
  ["The fourth take.", "The 4th take."],
  ["The one thousandth take.", "The 1,000th take."],
  ["The twenty-first take.", "The 21st take."],
  ["The one hundred and fourth take.", "The 104th take."],
  ["One million two hundred thousand takes.", "1,200,000 takes."],
  ["BrainBar is ready.", "Brain Bar is ready."],
  ["In twenty twenty-six.", "In 2026."],
  ["In nineteen ninety-nine.", "In 1999."],
  ["Twenty five percent.", "25%."],
  ["It cost four hundred dollars.", "It cost $ 400."],
  ["The behaviour catalogue recogniser centre licence.", "The behavior catalog recognizer center license."],
  ["Organise and recognise colourful material.", "Organize and recognize colorful material."],
];
for (const [sent, heard] of equivalent) {
  test(`equivalent: ${sent} / ${heard}`, () => {
    expect(wordMismatches(sent, words(heard), { setting: "a" }).pass).toBe(true);
    expect(wordMismatches(heard, words(sent), { setting: "a" }).pass).toBe(true);
  });
}
for (const [sent, heard] of [
  ["Four hundred takes.", "500 takes."],
  ["Four hundred red takes.", "400 takes."],
  ["Four hundred red takes.", "400 blue takes."],
  ["The lantern glows.", "The lantern grows."],
  ["One two takes.", "3 takes."],
  ["1000 takes.", "100 takes."],
  ["-400 takes.", "400 takes."],
  ["+400 takes.", "-400 takes."],
  ["9007199254740990.1 takes.", "9007199254740990.2 takes."],
  ["Twenty five percent.", "26%."],
  ["One thousand thousand takes.", "1000000 takes."],
  ["One thousand million takes.", "1000000000 takes."],
  ["One point five takes.", "15 takes."],
  ["Orc is ready.", "Ork is ready."],
  ["One hundred hundred takes.", "10000 takes."],
  ["Twenty and five takes.", "25 takes."],
  ["Four hundred dollars.", "400 takes."],
  ["Four hundred dollars.", "Four hundred."],
  ["Twenty five percent.", "25."],
  ["100000 takes.", "100001 takes."],
  ["The fourth take.", "The 5th take."],
  ["It cost $400.", "It cost 500."],
  ["21st take.", "21th take."],
]) {
  test(`rejects: ${sent} / ${heard}`, () => {
    expect(wordMismatches(sent, words(heard), { setting: "a" }).pass).toBe(false);
  });
}
test("strict mode keeps written and spoken forms distinct", () => {
  expect(wordMismatches("Four hundred takes", words("400 takes"), { tolerance: false }).pass).toBe(false);
});
test("normalization retains edit evidence next to a number", () => {
  const result = wordMismatches("Four hundred red takes", words("400 blue takes"));
  expect(result.edits).toHaveLength(1);
  expect(result.edits[0]).toMatchObject({ kind: "substitution", sentIndex: 2, recognisedIndex: 1,
    sent: ["red"], recognised: ["blue"], start: 1, end: 2 });
});

// Builder observations that remain real defects, not spelling aliases.
for (const [sent, heard] of [
  ["The settings work", "The setting work"],
  ["A new program", "A n-new progra"],
  ["The tooltip works", "The tooltop works"],
  ["It was ready", "It wa-it was ready"],
  ["The colour is red", "The colour is"],
  ["The catalogue is ready", "The catalogues is ready"],
  ["We guard the work", "We guard um the work"],
]) {
  test(`builder real defect: ${heard}`, () => {
    expect(wordMismatches(sent, words(heard), { setting: "a" }).pass).toBe(false);
  });
}

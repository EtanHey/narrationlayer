import { expect, test } from "bun:test";
import { deriveSpeechAliases, normalizeForSpeech } from "../src/text-normalize.js";
import { normalizeWordTimingsForScript } from "../src/word-timing-repair.js";

for (const [input, expected] of [
  ["9pm", "nine p m"], ["9 pm", "nine p m"], ["9 p.m.", "nine p m"],
  ["9PM", "nine p m"], ["11:30am", "eleven thirty a m"],
  ["11:30 a.m.", "eleven thirty a m"], ["at 21:00", "at nine p m"],
  ["by 21:15", "by nine fifteen p m"], ["9:05pm", "nine oh five p m"],
  ["at 00:00", "at twelve a m"], ["at 12:00", "at twelve p m"],
  ["PR #123", "pull request one twenty-three"], ["PR 123", "pull request one twenty-three"],
  ["pull request #123", "pull request one twenty-three"], ["e.g.", "for example"], ["i.e.", "that is"],
  ["vs.", "versus"], ["vs", "versus"], ["approx.", "approximately"], ["~5", "about five"],
  ["5%", "five percent"], ["%", "percent"], ["2.5x", "two point five times"], ["2x", "two times"],
  ["v2.3", "version two point three"], ["Use v2.3. Try ~5.", "Use version two point three. Try about five."],
]) test(`spoken form ${input}`, () => expect(normalizeForSpeech(input)).toBe(expected));

for (const input of ["PM spoke with AM about the plan.", "13pm 24:00 9:65pm", "v2beta", "Fix the #1 priority", "See issue #12", "x86", "12:34 long", "10:30 meeting"]) {
  test(`protected or unchanged ${input}`, () => expect(normalizeForSpeech(input)).toBe(input));
}

for (const [script, expected] of [
  ["by 9pm", [["by", 0, .25], ["9pm", .25, 1]]],
  ["by 9 p.m.", [["by", 0, .25], ["9", .25, .5], ["p.m.", .5, 1]]],
] satisfies Array<[string, Array<Array<string | number>>]>) test(`align authored ${script}`, () => {
  const raw = ["by", "nine", "p", "m"].map((word, i) => ({ index: i, word, start: i * .25, end: (i + 1) * .25 }));
  const copy = structuredClone(raw);
  const spoken = normalizeForSpeech(script);
  const result = normalizeWordTimingsForScript(script, raw, 1, deriveSpeechAliases(script, spoken));
  expect(result.words.map(({ word, start, end }) => [word, start, end])).toEqual(expected);
  expect(result.estimated).toBe(false);
  expect(raw).toEqual(copy);
});

test("explicit alias resolves a changed token with shared LCS pieces", () => {
  expect(deriveSpeechAliases("by 9pm", "by nine p m")).toContainEqual({ term: "9pm", spoken: "nine p m" });
  expect(deriveSpeechAliases("by 9pm", "by something else")).not.toContainEqual({ term: "9pm", spoken: "nine p m" });
});

test("aligns the complete clock span between neighboring words", () => {
  const raw = ["by", "nine", "p", "m", "tomorrow"].map((word, i) => ({ index: i, word, start: i * .2, end: (i + 1) * .2 }));
  const script = "by 9pm tomorrow";
  const result = normalizeWordTimingsForScript(script, raw, 1, deriveSpeechAliases(script, normalizeForSpeech(script)));
  expect(result.words.map(({ word, start, end }) => [word, start, end])).toEqual([["by", 0, .2], ["9pm", .2, .8], ["tomorrow", .8, 1]]);
});

test("pronunciation overlays affect only the engine and respect protected spans", async () => {
  const { prepareSpeechChannels } = await import("../src/text-normalize.js");
  const display = "Foobar at 9pm `Foobar` https://example.com/Foobar";
  expect(prepareSpeechChannels(display, [{ term: "Foobar", spoken: "foo bar" }])).toEqual({
    displayText: display,
    synthInput: "foo bar at nine p m `foo bar` https://example dot com/foo bar",
  });
});

test("protected code and URLs retain legacy speech, without new expansions", () => {
  expect(normalizeForSpeech("`9pm foo_bar` https://github.com/x86/9pm")).toBe("`9pm foo bar` https://github dot com/x86/9pm");
});

test("aliases deduplicate normalized forms and never emit partial or merged terms", () => {
  const text = "i.e. v2.3 and 9pm, then 9pm";
  const aliases = deriveSpeechAliases(text, normalizeForSpeech(text));
  const keys = aliases.map(a => `${a.term.toLowerCase().replace(/[^a-z0-9]/g, "")}\0${a.spoken.toLowerCase().replace(/[^a-z0-9]/g, "")}`);
  expect(new Set(keys).size).toBe(keys.length);
  expect(aliases.some(a => /\s/.test(a.term) || /^\d$/.test(a.term))).toBe(false);
  expect(aliases).toContainEqual({ term: "v2.3", spoken: "version two point three" });
});

test.each([
  "~21:00Z", "21:5x", "~21:0x", "PR 1/2", "PR 2026-10-22]",
  "~2026-11-01", "4b-1x", "PR #275/#276/#277", "~200–400ms", "6pm-mini",
])("leaves structured text untouched: %s", (text) => {
  expect(normalizeForSpeech(text)).toBe(text);
});

test.each([
  ["~30/30 GB", "~30/30 GB"],
  ["stable VS", "stable VS"],
  ["bge-large-en-v1.5", "bge-large-en-v1 dot 5"],
  ["v2026.10.27-0abede3", "v2026 dot 10 dot 27-0abede3"],
  ["v0.1.3-nightly", "v0 dot 1 dot 3-nightly"],
  ["fable 5x high", "fable 5x high"],
  ["Opus 5x high", "Opus 5x high"],
  ["fable 5x\nhigh", "fable 5x\nhigh"],
  ["PR #137 + #138", "PR #137 + #138"],
  ["at 21:00-mini", "at 21:00-mini"],
  ["6 p.m.-mini", "6 p dot m.-mini"],
  ["| 6x | Secret alerts", "| 6x | Secret alerts"],
  ["/node/v22.22.0/bin/node", "/node/v22 dot 22 dot 0/bin/node"],
])("keeps ambiguous identifier speech at its legacy form: %s", (input, expected) => {
  expect(normalizeForSpeech(input)).toBe(expected);
});

test.each([
  ["9am-5pm", "nine a m-five p m"],
  ["9 a.m.-5 p.m.", "nine a m-five p m"],
  ["9:30pm-10pm", "nine thirty p m-ten p m"],
  ["10am-12pm", "ten a m-twelve p m"],
  ["from 9pm-11pm", "from nine p m-eleven p m"],
  ["1am-2am", "one a m-two a m"],
  ["9am - 5pm", "nine a m - five p m"],
  ["9pm–10pm", "nine p m–ten p m"],
  ["6pm-mini", "6pm-mini"],
  ["6 p.m.-mini", "6 p dot m.-mini"],
  ["~98.5%", "about ninety-eight point five percent"],
  ["VS", "VS"], ["Vs.", "Vs."],
])("speech contract %s", (input, expected) => {
  expect(normalizeForSpeech(input)).toBe(expected);
});

test.each([
  ["~5%", "about five percent"],
  ["~50% of users", "about fifty percent of users"],
  ["~100%", "about one hundred percent"],
  ["~98.5%", "about ninety-eight point five percent"],
  ["9am-5pm-ish", "9am-5pm-ish"],
  ["1pm-2pm-mini", "1pm-2pm-mini"],
  ["5pm-6pm-7pm", "five p m-six p m-seven p m"],
  ["5pm-6pm-7pm-mini", "5pm-6pm-7pm-mini"],
  ["9 a.m.-5 p.m.-mini", "9 a dot m.-5 p dot m.-mini"],
  ["9-10pm", "9-ten p m"],
  ["~98.5%-99%", "~ninety-eight point five percent-ninety-nine percent"],
])("percentage and complete range contract %s", (input, expected) => {
  expect(normalizeForSpeech(input)).toBe(expected);
});

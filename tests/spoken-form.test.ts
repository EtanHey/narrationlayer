import { expect, test } from "bun:test";
import { deriveSpeechAliases, normalizeForSpeech } from "../src/text-normalize.js";
import { normalizeWordTimingsForScript } from "../src/word-timing-repair.js";

for (const [input, expected] of [
  ["9pm", "nine p m"], ["9 pm", "nine p m"], ["9 p.m.", "nine p m"],
  ["9PM", "nine p m"], ["11:30am", "eleven thirty a m"],
  ["11:30 a.m.", "eleven thirty a m"], ["21:00", "nine p m"],
  ["21:15", "nine fifteen p m"], ["9:05pm", "nine oh five p m"],
  ["00:00", "twelve a m"], ["12:00", "twelve p m"],
  ["PR #123", "pull request one twenty-three"], ["PR 123", "pull request one twenty-three"],
  ["#123", "pull request one twenty-three"], ["e.g.", "for example"], ["i.e.", "that is"],
  ["vs.", "versus"], ["vs", "versus"], ["approx.", "approximately"], ["~5", "about five"],
  ["5%", "five percent"], ["%", "percent"], ["x2", "two times"], ["2x", "two times"],
  ["v2.3", "version two point three"], ["Use v2.3. Try ~5.", "Use version two point three. Try about five."],
]) test(`spoken form ${input}`, () => expect(normalizeForSpeech(input)).toBe(expected));

for (const input of ["PM spoke with AM about the plan.", "13pm 24:00 9:65pm", "v2beta", "`9pm v2.3 PR #123 e.g. foo_bar`", "``v2.3 `9pm` ``", "```js\nconst version = 'v2.3'; // 9pm\n```", "~~~js\nconst version = 'v2.3';\n~~~", "https://example.com/v2.3?at=9pm#123", "http://example.com/~5/2x"]) {
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
    synthInput: "foo bar at nine p m `Foobar` https://example.com/Foobar",
  });
});

import { expect, test } from "bun:test";
import { planSynthesisUnits, type SynthesisSourceUnit } from "../../src/plan/synthesis-units.js";
import { planNarrationUtterances } from "../../src/plan/utterances.js";
import { characterizeBoundaries } from "./synthesis-boundaries.js";
import { lengthsFixture, plannerFixtures, shapeFixture } from "./synthesis-fixtures.js";
import golden from "./fixtures/synthesis-boundaries.golden.json";

function plan(text: string, max_chars: number, pause_after_ms = 180) {
  return planSynthesisUnits({
    units: [{ kind: "sentence", text, pause_after_ms }], max_chars,
  }).flatMap(piece => piece.segments);
}

test("PLAN-01: a one-word whole source is allowed; fragments of a longer source are not", () => {
  expect(plan("Hello", 20).map(part => part.text)).toEqual(["Hello"]);
  expect(plan("One two three four five six seven.", 14).every(part => part.text.split(" ").length >= 3)).toBe(true);
});

test("PLAN-02: a later fitting mark beats a colon and internal cuts add no pause", () => {
  const parts = plan("These garden notes: keep all roots wet, leave the green leaves dry until morning.", 42);
  expect(parts[0].text).toBe("These garden notes: keep all roots wet,");
  expect(parts.slice(0, -1).map(part => part.pause_after_ms)).toEqual([0]);
  expect(parts.at(-1)?.pause_after_ms).toBe(180);
});

test("PLAN-D4: last fitting phrase mark wins over a later bare space", () => {
  const parts = plan("One two three, four five six; seven eight nine ten eleven twelve.", 42);
  expect(parts[0].text).toBe("One two three, four five six;");
  for (const mark of [",", ";", ":", "—", "―", "–"]) {
    expect(plan(`One two three${mark} four five six seven eight nine.`, 26)[0].text).toBe(`One two three${mark}`);
  }
  expect(plan("One two three four five six seven eight nine.", 22)[0].text).toBe("One two three four");
});

test("PLAN-D5: two-word remainder joins; a three-word remainder stands", () => {
  expect(plan("One two three four five.", 14).map(part => part.text)).toEqual(["One two three four five."]);
  expect(plan("One two three four five six.", 14).map(part => part.text)).toEqual(["One two three", "four five six."]);
  expect(plan("Label: one two three four five six seven.", 18)[0].text.split(" ").length).toBeGreaterThanOrEqual(3);
  expect(plan("Two words", 3).map(part => part.text)).toEqual(["Two words"]);
});

test("PLAN-D5 characterization: job cutter and contract planner share the 2/3-word boundary", () => {
  for (const [text, expected] of [
    ["One two three four five.", ["One two three four five."]],
    ["One two three four five six.", ["One two three", "four five six."]],
  ] satisfies [string, string[]][]) {
    expect(planNarrationUtterances(text, { max_utterance_words: 3 }).map(part => part.text)).toEqual(expected);
    expect(plan(text, 14).map(part => part.text)).toEqual(expected);
  }
});

test("PAUSE-PL-01: each pause has one owner; only raw piece 0 uses the next piece", () => {
  const units: SynthesisSourceUnit[] = [
    { kind: "heading", text: "A garden heading", pause_after_ms: 210 },
    { kind: "sentence", text: "One two three four five six seven eight nine.", pause_after_ms: 320 },
    { kind: "sentence", text: "The flowers are blooming.", pause_after_ms: 0 },
  ];
  for (const first_piece_raw of [false, true]) {
    const pieces = planSynthesisUnits({ units, max_chars: 22, first_piece_raw });
    const placed = pieces.map(() => 0);
    pieces.forEach((piece, index) => {
      const segment = piece.segments[0];
      placed[index + (segment.pause_in === "next_piece_start" ? 1 : 0)] += segment.pause_after_ms;
    });
    expect(placed.reduce((sum, pause) => sum + pause, 0)).toBe(530);
    expect(placed[0]).toBe(first_piece_raw ? 0 : 210);
    expect(pieces.filter(piece => piece.segments[0].pause_in === "next_piece_start").length).toBe(first_piece_raw ? 1 : 0);
    expect(pieces.flatMap(piece => piece.segments).filter(segment => segment.pause_after_ms > 0).map(segment => segment.pause_after_ms)).toEqual([210, 320]);
  }
});

test("PLAN-03: projected shapes stay whole except the over-limit sentence", () => {
  const segments = planSynthesisUnits(shapeFixture).flatMap(piece => piece.segments);
  shapeFixture.units.forEach((unit, index) => {
    const requests = segments.filter(segment => segment.source_units.includes(index));
    expect(requests.map(request => request.text).join(" ")).toBe(unit.text);
    if (unit.kind !== "sentence") expect(requests).toHaveLength(1);
    else {
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.slice(0, -1).every(request => /[,;:—–-]$/.test(request.text))).toBe(true);
    }
  });
});

test("PLAN-03: recorded lengths only, without the old latency-budget policy", () => {
  expect(lengthsFixture.units.map(unit => unit.text.length)).toEqual([7, 23, 39, 192, 264]);
  expect(lengthsFixture.units[4].text.split(". ").map(text => text.length)).toEqual([142, 120]);
  expect(planSynthesisUnits(lengthsFixture).map(piece => piece.segments[0].text)).toEqual(lengthsFixture.units.map(unit => unit.text));
});

test("PLAN-03 golden: runner and contract boundary differences are characterized", () => {
  expect(characterizeBoundaries()).toEqual(golden);
});

test("planner is deterministic, preserves inputs, and validates its numeric boundary", () => {
  const before = JSON.stringify(plannerFixtures);
  expect(planSynthesisUnits(shapeFixture)).toEqual(planSynthesisUnits(shapeFixture));
  expect(JSON.stringify(plannerFixtures)).toBe(before);
  expect(planSynthesisUnits({ units: [], max_chars: 10 })).toEqual([]);
  for (const max_chars of [0, -1, NaN, Infinity, 1.5]) {
    expect(() => planSynthesisUnits({ units: [], max_chars })).toThrow(RangeError);
  }
  expect(() => plan("", 10)).toThrow(RangeError);
  expect(() => plan("One two three.", 20, -1)).toThrow(RangeError);
  expect(plan("Indivisible", 2)[0].text).toBe("Indivisible");
  expect(() => planSynthesisUnits({ units: [{ kind: "heading", text: "Hello", pause_after_ms: 10 }], max_chars: 10, first_piece_raw: true })).toThrow(RangeError);
});

const w = (n: number) => Array(n).fill("lantern").join(" ");
for (const [tail, lengths] of [
  ["first- and second-rate lanterns glow.", [106, 26]],
  ["pages 3- 4 lantern lantern lantern.", [106, 24]],
] satisfies [string, number[]][]) test(`PLAN-D4: a hyphen that joins words is not a cut point: ${tail}`, () => {
  const text = `${w(12)} ${tail}`, parts = plan(text, 120);
  expect(parts.map(p => p.text.length)).toEqual(lengths);
  expect(parts.map(p => p.text).join(" ")).toBe(text);
  for (const p of parts) expect(p.text.split(" ").filter(w => /[\p{L}\p{N}]/u.test(w)).length).toBeGreaterThanOrEqual(3);
});
test("PLAN-D4: attached hyphen falls back to space; a lone hyphen is a mark", () => {
  const parts = plan("One two three- four five six seven eight nine.", 26);
  expect(parts[0].text).toBe("One two three- four five");
  for (const p of parts) expect(p.text.split(" ").length).toBeGreaterThanOrEqual(3);
  expect(plan("One two three - four five six seven eight nine.", 26).map(p => p.text)).toEqual(["One two three -", "four five six", "seven eight nine."]);
});
for (const [tail, lengths] of [
  ["amber - tail words lantern lantern.", [103, 27]],
  ["amber— tail words lantern lantern.", [102, 27]],
  ["amber ― tail words lantern lantern.", [103, 27]],
  ["amber – tail words lantern lantern.", [103, 27]],
  ["amber —tail words lantern lantern.", [107, 22]],
] satisfies [string, number[]][]) test(`PLAN-D4: dash control ${tail}`, () => {
  expect(plan(`${w(12)} ${tail}`, 120).map(p => p.text.length)).toEqual(lengths);
});

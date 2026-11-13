import { expect, test } from "bun:test";
import { planSynthesisUnits } from "../../src/plan/synthesis-units.js";
import fixtures from "./fixtures/synthesis-round1.json";

function run(row: typeof fixtures[number]) {
  return planSynthesisUnits({ units: [{
    kind: row.kind === "heading" ? "heading" : row.kind === "list_item" ? "list_item" : "sentence",
    text: row.text, pause_after_ms: 0,
  }], max_chars: row.max_chars }).flatMap(piece => piece.segments);
}
const outputs = (id: string) => fixtures.filter(row => row.id === id).flatMap(run);
const words = (text: string) => text.split(/\s+/u).filter(token => /[\p{L}\p{N}]/u.test(token)).length;

test("PLAN-D4 round1: unspaced em dash and spaced horizontal bar are phrase marks", () => {
  expect(outputs("finding-1-em-dash")[0].text).toBe("The gardeners walked slowly—");
  expect(outputs("finding-1-horizontal-bar")[0].text).toBe("The gardeners walked slowly ―");
});

test("PLAN-D4 round1: hyphenated words and en-dash ranges are not phrase marks", () => {
  expect(outputs("hyphen")[0].text).toBe("One two three well-known four");
  expect(outputs("range")[0].text).toBe("One two three 1990–2000 four");
});

test("PLAN-03 round1: over-cap headings and items stay whole and report over_cap", () => {
  for (const row of fixtures.filter(row => row.kind)) {
    expect(run(row).map(segment => segment.text)).toEqual([row.text]);
    expect(run(row)[0].over_cap).toBe(true);
  }
});

test("PLAN-D5 round1: step back within the cap where possible; flag unavoidable excess", () => {
  expect(outputs("previous-phrase").map(segment => segment.text)).toEqual([
    "One two three,", "four five six; seven eight.",
  ]);
  expect(outputs("finding-2-words").map(segment => segment.text)).toEqual([
    "One two three four five six seven", "eight nine ten.",
  ]);
  expect(outputs("finding-2-expanded-words").map(segment => segment.text)).toEqual([
    "One two, three four five six", "seven eight nine ten", "eleven twelve thirteen.",
  ]);
  for (const id of ["finding-2-words", "finding-2-expanded-words"]) {
    expect(outputs(id).every(segment => !segment.over_cap && words(segment.text) >= 3)).toBe(true);
  }
  for (const id of ["finding-2-url", "finding-2-literal-ellipsis", "finding-2-list-item"]) {
    expect(outputs(id)[0].over_cap).toBe(true);
    expect(outputs(id).every(segment => words(segment.text) >= 3)).toBe(true);
  }
});

test("PLAN-D5 round1: punctuation-only tokens do not satisfy the spoken word minimum", () => {
  expect(outputs("finding-4-punctuation").map(segment => segment.text)).toEqual([
    "One two three four five", "six seven eight — — —",
  ]);
});

test("round1: every new input joins back with its original intervening whitespace", () => {
  for (const row of fixtures) {
    const normalized = row.text.trim().replace(/\s+/gu, " ");
    let joined = "";
    for (const segment of run(row)) {
      // A cut at an unspaced dash has no separator; other cuts can consume one normalized space.
      if (normalized[joined.length] === " ") joined += " ";
      joined += segment.text;
      expect(normalized.startsWith(joined)).toBe(true);
      expect(segment.over_cap).toBe(segment.text.length > row.max_chars);
    }
    expect(joined).toBe(normalized);
  }
});

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { planSynthesisUnits } from "../../src/plan/synthesis-units.js";
import fixture from "./fixtures/cutter-cost.digests.json";

function* cases(count: number) {
  let seed = 0x6c61796;
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const marks = [",", ";", ":", "—", "―", "–", "-"];
  const alphabet = ["a", "ב", "界", "😀", "𐐀", "7", "—"];
  for (let i = 0; i < count; i++) {
    const max_chars = i % 400 + 1;
    const tokens = Array.from({ length: next(25) + 1 }, () => {
      const word = alphabet[next(alphabet.length)].repeat(next(60) + 1);
      const mark = marks[next(marks.length)];
      return word + (i % 4 === 0 ? "" : next(2) ? mark : mark + "a");
    });
    if (i % 5 === 0) tokens.splice(next(tokens.length + 1), 0, "x".repeat(max_chars + 1));
    if (i % 7 === 0) tokens.splice(0, 0, "x".repeat(Math.max(0, max_chars - 1)) + marks[i % marks.length]);
    if (i % 11 === 0) tokens.splice(0, 0, "x".repeat(max_chars) + marks[i % marks.length]);
    const text = tokens.join([" ", "  ", "\t", "\n", " \t\n "][i % 5]);
    yield { text, max_chars };
  }
}

const plan = (text: string, max_chars: number) => planSynthesisUnits({
  units: [{ kind: "sentence", text, pause_after_ms: 200 }], max_chars,
});

test("cutter cost: planning time grows linearly with one long sentence", () => {
  const inputs = [10_000, 40_000].map(n => Array.from({ length: n },
    (_, i) => `word${i % 11 === 10 ? "," : ""}`).join(" "));
  const counts = inputs.map(text => {
    let work = 0;
    const matchAll = RegExp.prototype[Symbol.matchAll];
    const { slice, indexOf } = String.prototype;
    try {
      // Charge whole iterator inputs even when iteration stops early. Token tests
      // and candidate loops are bounded by these characters, not counted twice.
      RegExp.prototype[Symbol.matchAll] = function (text: string) {
        work += text.length;
        return matchAll.call(this, text);
      };
      String.prototype.slice = function (start?: number, end?: number) {
        const result = slice.call(this, start, end);
        work += result.length;
        return result;
      };
      String.prototype.indexOf = function (search: string, position?: number) {
        const result = indexOf.call(this, search, position);
        const from = Math.min(Math.max(Math.trunc(position ?? 0) || 0, 0), this.length);
        work += Math.max(0, (result < 0 ? this.length : result + search.length) - from);
        return result;
      };
      plan(text, 150);
    } finally {
      RegExp.prototype[Symbol.matchAll] = matchAll;
      String.prototype.slice = slice;
      String.prototype.indexOf = indexOf;
    }
    expect(RegExp.prototype[Symbol.matchAll]).toBe(matchAll);
    expect(String.prototype.slice).toBe(slice);
    expect(String.prototype.indexOf).toBe(indexOf);
    return work;
  });
  // Update only after auditing changed scans; recompute both pins and prove the
  // unbounded-window mutation fails. This is a scan budget, not instruction count.
  expect(counts).toEqual([476_486, 1_906_557]);
  expect(counts[1] / counts[0]).toBeLessThan(6);
});

// SHA256 of planner output in seed order; attached-hyphen rule revised with a side-by-side differential.
test("cutter cost: the cuts are unchanged", () => {
  let i = 0;
  for (const row of cases(fixture.length)) {
    const digest = createHash("sha256").update(JSON.stringify(plan(row.text, row.max_chars))).digest("hex");
    expect(digest, `input ${i}: length ${row.text.length}, cap ${row.max_chars}`).toBe(fixture[i++]);
  }
});

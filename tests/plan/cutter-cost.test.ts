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

// SHA256 of JSON.stringify(base 8dd07dc planner output), in seed order; Bun 1.3.11.
test("cutter cost: the cuts are unchanged", () => {
  let i = 0;
  for (const row of cases(fixture.length)) {
    const digest = createHash("sha256").update(JSON.stringify(plan(row.text, row.max_chars))).digest("hex");
    expect(digest, `input ${i}: length ${row.text.length}, cap ${row.max_chars}`).toBe(fixture[i++]);
  }
});

test("cutter cost: planning time grows linearly with one long sentence", () => {
  const inputs = [10_000, 40_000].map(n => Array.from({ length: n },
    (_, i) => `word${i % 11 === 10 ? "," : ""}`).join(" "));
  for (const text of inputs) plan(text, 150);
  const samples: number[][] = inputs.map(() => []);
  for (let run = 0; run < 5; run++) {
    inputs.forEach((text, i) => {
      const start = performance.now();
      plan(text, 150);
      samples[i].push(performance.now() - start);
    });
  }
  const [small, large] = samples.map(times => times.sort((a, b) => a - b)[2]);
  expect(large / small).toBeLessThan(6);
});

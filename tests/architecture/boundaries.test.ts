// Invariant I-D: import rules only tighten. See scripts/dev/boundaries.ts and tests/architecture/ledger.json.
import { expect, test } from "bun:test";

import {
  BASELINE_PATH,
  entryProblems,
  importSpecifiers,
  isReexportOnly,
  isShim,
  LEDGER_PATH,
  ledgerProblems,
  readJson,
  violations,
  type Ledger,
} from "../../scripts/dev/boundaries.js";

const ledger = readJson<Ledger>(LEDGER_PATH);
const baseline = readJson<string[]>(BASELINE_PATH);
const current = violations(ledger);

test("the parser sees every import form, including type-only ones", () => {
  const source = [
    `import a from "./a.js";`,
    `import type { B } from "./b.js";`,
    `import { type C } from "./c.js";`,
    `export { d } from "./d.js";`,
    `export type { E } from "./e.js";`,
    `export * from "./f.js";`,
    `const g = await import("./g.js");`,
    `type H = import("./h.js").H;`,
    `import i = require("./i.js");`,
  ].join("\n");
  expect(importSpecifiers(source)).toEqual(["./a.js", "./b.js", "./c.js", "./d.js", "./e.js", "./f.js", "./g.js", "./h.js", "./i.js"]);
});

test("shim detection: re-export-only bodies are shims, a real module that also re-exports is not", () => {
  expect(isReexportOnly(`export * from "./audio/impl.js";`)).toBe(true);
  expect(isReexportOnly(`import { a } from "./a.js";\nexport { a };\nexport type B = import("./b.js").B;`)).toBe(true);
  expect(isReexportOnly(`export type B = import("./b.js").B;\nexport const c = 1;`)).toBe(false);
  expect(isReexportOnly(`import "./side-effect.js";`)).toBe(false);
  expect(isShim("src/schema.ts", ledger)).toBe(false);
});

test("every .ts file under src/, bin/ and scripts/ has one well-formed ledger row", () => {
  expect(ledgerProblems(ledger)).toEqual([]);
});

test("no import violation outside the baseline", () => {
  expect(current.filter((v) => !baseline.includes(v))).toEqual([]);
});

test("every baseline entry still occurs, so the baseline can only shrink", () => {
  expect(baseline.filter((v) => !current.includes(v))).toEqual([]);
});

test("the baseline is sorted, unique and owned by a slice or a named exemption", () => {
  expect(baseline).toEqual([...new Set(baseline)].sort());
  for (const entry of baseline) {
    const from = entry.split(" ")[1];
    expect(Boolean(ledger.files[from]?.owner || ledger.files[from]?.exempt?.startsWith("named exemption"))).toBe(true);
  }
});

test("entry files keep their import.meta.main block and import.meta.dir profile root", () => {
  expect(Object.entries(ledger.files).filter(([, e]) => e.entry).map(([f]) => f).sort()).toEqual([
    "bin/local-tts-runner.ts",
    "src/cli.ts",
    "src/mcp-server.ts",
  ]);
  expect(entryProblems(ledger)).toEqual([]);
});

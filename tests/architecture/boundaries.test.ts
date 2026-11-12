// Invariant I-D: import rules only tighten. See scripts/dev/boundaries.ts and tests/architecture/ledger.json.
import { expect, test } from "bun:test";
import { analyze, BASELINE_PATH, entryProblems, LEDGER_PATH, ledgerProblems, moduleFacts, readJson, violations, type Ledger } from "../../scripts/dev/boundaries.js";

const ledger = readJson<Ledger>(LEDGER_PATH);
const baseline = readJson<string[]>(BASELINE_PATH);
const current = violations(ledger);

// In-memory fixture: src/audio.ts is the legacy path, src/audio/impl.ts the moved implementation.
const row = (layer: 0 | 2 | 3, area: string) => ({ layer, area, owner: "fixture" });
const fixtureLedger: Ledger = { layers: {}, files: { "src/audio.ts": row(2, "audio"), "src/audio/impl.ts": row(2, "audio"), "src/caller.ts": row(3, "pipelines"), "src/core/a.ts": row(0, "core"), "src/core/fwd.ts": row(0, "core") } };
function fixture(files: Record<string, string>) {
  const all: Record<string, string> = { "src/audio/impl.ts": "export function detectSilences() { return 1; }\nexport default function parse() { return 2; }\n", "src/caller.ts": `import { detectSilences } from "./audio.js";\nexport const n = detectSilences();\n`, ...files };
  return analyze(fixtureLedger, { files: Object.keys(all).sort(), read: (f) => all[f] });
}
const VIA = "via-reexport src/caller.ts -> src/audio.ts (detectSilences)";

test("the parser sees every import form, including type-only ones and require()", () => {
  const source = [`import a from "./a.js";`, `import type { B } from "./b.js";`, `import { type C } from "./c.js";`, `export { d } from "./d.js";`, `export type { E } from "./e.js";`, `export * from "./f.js";`, `const g = await import("./g.js");`, `type H = import("./h.js").H;`, `import i = require("./i.js");`, `const j = require("./j.js");`, `import * as k from "./k.js";`, `import "./l.js";`].join("\n");
  expect([...new Set(moduleFacts(source).uses.map((u) => u.spec))].sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((x) => `./${x}.js`));
});

test.each([
  ["round 1: plain re-export", `export * from "./audio/impl.js";\n`],
  ["round 2: stray empty statement", `export * from "./audio/impl.js";\n;\n`],
  ["round 2: unused private type", `export * from "./audio/impl.js";\ntype Compatibility = unknown;\n`],
  ["round 2: forwarded default", `import audio from "./audio/impl.js";\nexport * from "./audio/impl.js";\nexport default audio;\n`],
  ["partly-real module", `export const own = 1;\nexport * from "./audio/impl.js";\n`],
  ["named forward", `export { detectSilences } from "./audio/impl.js";\nexport const own = 1;\n`],
  ["import then export", `import { detectSilences } from "./audio/impl.js";\nexport { detectSilences };\n`],
])("an internal import of a name the legacy path only forwards fails: %s", (_label, legacy) => {
  const { violations: found } = fixture({ "src/audio.ts": legacy });
  expect(found).toContain(VIA);
  expect(found.filter((v) => v.includes("src/audio.ts ->"))).toEqual([]); // the forwarder itself is exempt
});

test("names a module declares itself stay legal, even beside forwarded ones; namespace imports of a forwarder fail", () => {
  expect(fixture({ "src/audio.ts": "export function detectSilences() { return 1; }\nexport type T = import(\"./audio/impl.js\").T;\n" }).violations).toEqual([]);
  const partly = fixture({ "src/audio.ts": `export const own = 1;\nexport * from "./audio/impl.js";\n`, "src/caller.ts": `import { own } from "./audio.js";\nimport * as all from "./audio.js";\nexport const n = [own, all];\n` });
  expect(partly.violations).toEqual(["via-reexport src/caller.ts -> src/audio.ts (*)"]);
});

test("an upward edge cannot hide behind a forwarding module", () => {
  const found = fixture({ "src/core/fwd.ts": `export const own = 1;\nexport { detectSilences } from "../audio/impl.js";\n`, "src/core/a.ts": `import { detectSilences } from "./fwd.js";\nexport const x = detectSilences;\n` }).violations;
  expect(found).toContain("via-reexport src/core/a.ts -> src/core/fwd.ts (detectSilences)");
  expect(found).toContain("upward src/core/a.ts -> src/audio/impl.ts");
});

test("a relative import that resolves to no file is a hard failure", () => {
  expect(fixture({ "src/audio.ts": `export * from "./audio/impl.js";\nimport "./missing.js";\n` }).unresolved).toEqual(["unresolved import src/audio.ts -> ./missing.js"]);
});

test("every .ts file under src/, bin/ and scripts/ has one well-formed ledger row and every relative import resolves", () => {
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
  expect(Object.entries(ledger.files).filter(([, e]) => e.entry).map(([f]) => f).sort()).toEqual(["bin/local-tts-runner.ts", "bin/narration-gate.ts", "src/cli.ts", "src/mcp-server.ts"]);
  expect(entryProblems(ledger)).toEqual([]);
});

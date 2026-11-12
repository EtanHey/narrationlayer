// Invariant I-D: import rules only tighten. See scripts/dev/boundaries.ts and tests/architecture/ledger.json.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyze, BASELINE_PATH, diskRepo, entryProblems, importSpecifiers, LEDGER_PATH, ledgerProblems, readJson, ROOT, violations, type Ledger } from "../../scripts/dev/boundaries.js";

const ledger = readJson<Ledger>(LEDGER_PATH);
const baseline = readJson<string[]>(BASELINE_PATH);
const current = violations(ledger);

// In-memory fixture: src/core/a.ts (L0) is the importer under test.
const row = (layer: 0 | 2 | "api", area: string, entry?: string[]) => ({ layer, area, owner: "fixture", ...(entry ? { entry } : {}) });
const fixtureLedger: Ledger = { layers: {}, files: { "src/core/a.ts": row(0, "core"), "src/audio/impl.ts": row(2, "audio"), "src/timing/t.ts": row(2, "timing"), "src/api/index.ts": row("api", "api"), "src/main.ts": row(0, "core", ["if (import.meta.main)", `path.resolve(import.meta.dir, "..")`]) } };
function fixture(files: Record<string, string>, untracked: Record<string, string> = {}) {
  const all: Record<string, string> = { "src/core/a.ts": "export const a = 1;\n", "src/audio/impl.ts": "export type T = { n: number };\nexport const f = () => 1;\n", "src/timing/t.ts": "export const t = 1;\n", "src/api/index.ts": `export { f } from "../audio/impl.js";\n`, "src/main.ts": `const root = path.resolve(import.meta.dir, "..");\nif (import.meta.main) {}\n`, ...files };
  const tracked = new Set(Object.keys(all));
  const repo = { files: [...tracked].filter((f) => /^src\/.*(?<!\.d)\.ts$/.test(f)).sort(), tracked, read: (f: string) => all[f] ?? untracked[f] };
  return { ...analyze(fixtureLedger, repo), ledger: ledgerProblems(fixtureLedger, repo), entry: entryProblems(fixtureLedger, repo) };
}
const UP = "upward src/core/a.ts -> src/audio/impl.ts";

test("the parser sees every import form, including type-only ones and require()", () => {
  const source = [`import a from "./a.js";`, `import type { B } from "./b.js";`, `import { type C } from "./c.js";`, `export { d } from "./d.js";`, `export type { E } from "./e.js";`, `export * from "./f.js";`, `const g = await import("./g.js");`, `type H = import("./h.js").H;`, `import i = require("./i.js");`, `const j = require("./j.js");`, `import * as k from "./k.js";`, `import "./l.js";`, `export type M = import("./m.js").M;`].join("\n");
  expect(importSpecifiers(source)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"].map((x) => `./${x}.js`));
});

test.each([
  ["value import", `import { f } from "../audio/impl.js";\nexport const x = f();\n`],
  ["type-only import", `import type { T } from "../audio/impl.js";\nexport const x = (t: T) => t;\n`],
  ["export … from", `export { f } from "../audio/impl.js";\n`],
  ["export *", `export * from "../audio/impl.js";\n`],
  ["exported import() alias, used locally", `export type T = import("../audio/impl.js").T;\nexport const keep = (x: T): T => x;\n`],
  ["exported import() alias, unused", `export type T = import("../audio/impl.js").T;\n`],
  ["private import() alias, used locally", `type T = import("../audio/impl.js").T;\nexport const keep = (x: T): T => x;\n`],
  ["private import() alias, unused", `type T = import("../audio/impl.js").T;\n`],
  ["dynamic import()", `export const load = () => import("../audio/impl.js");\n`],
  ["require()", `export const m = require("../audio/impl.js");\n`],
])("an upward edge fails whatever its form: %s", (_label, source) => {
  expect(fixture({ "src/core/a.ts": source }).violations).toEqual([UP]);
});

test("cross-area and via-api imports fail", () => {
  expect(fixture({ "src/audio/impl.ts": `import type { t } from "../timing/t.js";\nexport const f = () => t;\n` }).violations).toEqual(["cross-area src/audio/impl.ts -> src/timing/t.ts"]);
  expect(fixture({ "src/core/a.ts": `import { f } from "../api/index.js";\nexport const x = f;\n` }).violations).toEqual(["via-api src/core/a.ts -> src/api/index.ts"]);
});

test("a relative import that resolves to no file is a hard failure, in every form", () => {
  const found = fixture({ "src/core/a.ts": `import "./gone1.js";\nexport type M = import("./gone2.js").M;\nexport const r = require("./gone3.js");\n` });
  expect(found.unresolved).toEqual(["./gone1.js", "./gone2.js", "./gone3.js"].map((s) => `unresolved import src/core/a.ts -> ${s}`));
  expect(found.ledger).toEqual(found.unresolved);
});

test("imports resolve only to tracked paths by exact string: wrong case and untracked targets are unresolved", () => {
  const found = fixture({ "src/core/a.ts": `import { f } from "../audio/Impl.js";\nimport "./stray.js";\n` }, { "src/audio/Impl.ts": "export const f = 1;\n", "src/core/stray.ts": "export {};\n" });
  expect(found.unresolved).toEqual(["unresolved import src/core/a.ts -> ../audio/Impl.js", "unresolved import src/core/a.ts -> ./stray.js"]);
});

test("an import of a tracked in-scope file with no ledger row names importer and target; out-of-scope targets are ignored", () => {
  const found = fixture({ "src/core/extra.ts": "export const e = 1;\n", "package.json": "{}\n", "src/core/a.ts": `import "./extra.js";\nimport pkg from "../../package.json";\nexport const p = pkg;\n` });
  expect(found.unresolved).toEqual(["import of an unledgered file src/core/a.ts -> src/core/extra.ts"]);
  expect(found.ledger).toEqual(["missing from ledger: src/core/extra.ts", ...found.unresolved]);
  expect(fixture({ "src/core/types.d.ts": "declare const x: number;\n" }).ledger).toEqual([]); // declaration files are out of scope
});

test("an unledgered file and a lost or unlisted entry marker are hard failures", () => {
  expect(fixture({ "src/core/new.ts": "export const n = 1;\n" }).ledger).toEqual(["missing from ledger: src/core/new.ts"]);
  expect(fixture({}).entry).toEqual([]);
  expect(fixture({ "src/main.ts": `const root = path.resolve(import.meta.dir, "..");\nif ((import.meta.main)) {}\n` }).entry).toEqual([]);
  const commentsOnly = `// const root = path.resolve(import.meta.dir, "..");\n// if (import.meta.main) {}\nexport const s = "if (import.meta.main)";\n`;
  expect(fixture({ "src/main.ts": commentsOnly }).entry).toEqual(["src/main.ts lost entry marker: if (import.meta.main)", `src/main.ts lost entry marker: path.resolve(import.meta.dir, "..")`]);
  expect(fixture({ "src/core/a.ts": "if (import.meta.main) {}\n" }).entry).toEqual(["src/core/a.ts has an import.meta.main block but no entry row"]);
});

test("only tracked files need a ledger row: an untracked stray file does not fail, a tracked one does", () => {
  mkdirSync(path.join(ROOT, "dist"), { recursive: true }); // dist/ is gitignored; the throwaway repo lives there
  const dir = mkdtempSync(path.join(ROOT, "dist", ".ledger-git-"));
  try {
    const git = (...args: string[]) => expect(spawnSync("git", args, { cwd: dir }).status).toBe(0);
    git("init", "-q");
    mkdirSync(path.join(dir, "src"));
    for (const name of ["tracked", "untracked"]) writeFileSync(path.join(dir, `src/${name}.ts`), "export const a = 1;\n");
    git("add", "src/tracked.ts");
    expect(ledgerProblems({ layers: {}, files: {} }, diskRepo(dir))).toEqual(["missing from ledger: src/tracked.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

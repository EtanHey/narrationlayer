import { expect, test } from "bun:test";
import { engineReach, type Repo } from "../../scripts/dev/boundaries.js";

const pinned = [
  "src/core/render-types.ts",
  "src/engine/artifacts/store.ts",
  "src/engine/core/engine.ts",
  "src/engine/messages/messages.ts",
  "src/engine/messages/parser.ts",
  "src/engine/messages/schema.ts",
  "src/engine/publication/decoded.ts",
  "src/engine/publication/publication.ts",
  "src/engine/publication/time.ts",
  "src/engine/reducer/pacing.ts",
  "src/engine/reducer/session.ts",
  "src/engine/selection/voice.ts",
  "src/engine/session/session.ts",
  "src/plan/read-plan.ts",
  "src/plan/synthesis-units.ts",
  "src/schema.ts",
  "src/text/voicelayer/display-tokens.ts",
  "src/text/voicelayer/inline-code-spans.ts",
  "src/text/voicelayer/markdown-to-speech.ts",
  "src/text/voicelayer/sections.ts",
  "src/text/voicelayer/structured-display.ts",
  "src/text/voicelayer/structured-speech.ts",
  "src/timing/returned-timings.ts",
];

test("engine reach: nothing the engine imports can block", () => {
  const result = engineReach();
  expect(result.violations).toEqual([]);
  for (const [file, importer] of result.reached) {
    expect(pinned.includes(file), `the engine now reaches ${file} through ${importer ?? "engine root"}: add it to the list if it cannot block`).toBe(true);
  }
  expect([...result.reached.keys()].sort()).toEqual(pinned);
});

function fixture(source: string, more: Record<string, string> = {}, untracked: Record<string, string> = {}) {
  const files: Record<string, string> = { "src/engine/main.ts": source, ...more };
  const repo: Repo = { files: Object.keys(files), tracked: new Set(Object.keys(files)), read: f => files[f] ?? untracked[f] };
  return engineReach(repo);
}

test.each(["readFileSync()", "fs.writeFileSync()", 'fs["existsSync"]()', "Bun.spawnSync([])", "Atomics.wait(a, 0, 1)", 'Atomics["wait"](a, 0, 1)'])
("engine reach: rejects blocking syntax %s", call => {
  const result = fixture('import "../plan/helper.js";', { "src/plan/helper.ts": `${call};` });
  expect(result.violations).toEqual([`engine blocking call src/plan/helper.ts: ${call.slice(0, call.indexOf("("))}`]);
});

test.each(["node:fs", "fs", "node:fs/promises", "node:child_process", "node:worker_threads", "node:net", "node:http", "bun:ffi", "some-package"])
("engine reach: refuses unapproved external %s", spec => {
  expect(fixture(`import type { T } from "${spec}";`).violations).toEqual([`engine external import src/engine/main.ts -> ${spec}`]);
});

test("engine reach: provenance through two type-only and re-export hops is checked", () => {
  const result = fixture('import type { T } from "../plan/helper.js";', {
    "src/plan/helper.ts": 'export type { T } from "../pipelines/job-render-provenance.js";',
    "src/pipelines/job-render-provenance.ts": 'import { execSync } from "node:child_process"; execSync("git rev-parse HEAD");',
  });
  expect(result.reached.get("src/pipelines/job-render-provenance.ts")).toBe("src/plan/helper.ts");
  expect(result.violations).toEqual([
    "engine blocking call src/pipelines/job-render-provenance.ts: execSync",
    "engine external import src/pipelines/job-render-provenance.ts -> node:child_process",
  ]);
});

test.each(['import(name)', 'require(name)', 'import x = require("node:crypto")'])
("engine reach: rejects loaders %s", source => {
  expect(fixture(source).violations).toEqual([`engine loader src/engine/main.ts: ${source.startsWith("import(name)") ? "import()" : "require()"}`]);
  expect(fixture('import "../plan/helper";', { "src/plan/helper.ts": source }).violations)
    .toEqual([`engine loader src/plan/helper.ts: ${source.startsWith("import(name)") ? "import()" : "require()"}`]);
});

test("engine reach: unresolved or untracked relative import is refused", () => {
  expect(fixture('import "./missing.js";', {}, { "src/engine/missing.ts": "export {};" }).violations)
    .toEqual(["engine unresolved import src/engine/main.ts -> ./missing.js"]);
});

test("engine reach: comments, strings, approved crypto and unreachable calls are harmless", () => {
  const result = fixture('// readFileSync(); import(name);\nconst text = "readFileSync()"; import "node:crypto";', {
    "src/plan/unreachable.ts": 'readFileSync(); import("node:fs");',
    "src/engine/conformance/entry.ts": 'Bun.spawnSync([]); require("node:fs");',
  });
  expect(result.violations).toEqual([]);
  expect([...result.reached.keys()]).toEqual(["src/engine/main.ts"]);
});

test("engine reach: import type expressions and namespace imports remain static edges", () => {
  const result = fixture('type T = import("../plan/types.js").T; import * as types from "../plan/types.js";', {
    "src/plan/types.ts": "existsSync();",
  });
  expect(result.violations).toEqual(["engine blocking call src/plan/types.ts: existsSync"]);
});


test("engine reach: package self-references also require approval", () => {
  const result = fixture('import "self";', {
    "package.json": JSON.stringify({ name: "self", exports: { ".": "./src/plan/helper.ts" } }),
    "src/plan/helper.ts": "export {};",
  });
  expect(result.violations).toEqual(["engine external import src/engine/main.ts -> self"]);
});

// The earlier review's twelve missed forms, followed by its twenty-one caught forms.
const reviewedForms = [
  ['({ readFileSync: r }) => r()', {}],
  ['const w = Atomics.wait; w()', {}],
  ['Reflect.apply(Atomics.wait, Atomics, [a, 0, 1])', {}],
  ['Atomics.wait.call(Atomics, a, 0, 1)', {}],
  ['(0, Atomics.wait)(a, 0, 1)', {}],
  ['require.resolve(x)', {}],
  ['eval("import(name)")', {}],
  ['new Function("return 1")', {}],
  ['process.binding("fs")', {}],
  ['const { readFileSync: r } = process.getBuiltinModule("fs"); r(x)', {}],
  ['Bun.which("tool")', {}],
  ['new Worker(new URL("worker.js", import.meta.url))', {}],
  ['export * from "../plan/helper"', { 'src/plan/helper.ts': 'readFileSync()' }],
  ['import x = require("node:crypto")', {}],
  ['import type { T } from "../plan/helper"', { 'src/plan/helper.ts': 'readFileSync()' }],
  ['import "../plan/helper.js"', { 'src/plan/helper.ts': 'readFileSync()' }],
  ['import "../plan/helper"', { 'src/plan/helper/index.ts': 'readFileSync()' }],
  ['import * as fs from "node:fs"; fs.readFileSync(x)', {}],
  ['import fs from "node:fs"; fs.readFileSync(x)', {}],
  ['({ readFileSync }) => readFileSync()', {}],
  ['import fs from "node:fs"; const r = fs.readFileSync; r()', {}],
  ['fs?.readFileSync?.(x)', {}],
  ['Atomics?.wait(a, 0, 1)', {}],
  ['Bun.spawnSync([])', {}],
  ['Bun.file(x).textSync()', {}],
  ['Bun.sleepSync(1)', {}],
  ['Atomics.wait(a, 0, 1)', {}],
  ['import cp from "node:child_process"; cp.execFileSync(x)', {}],
  ['globalThis.require(x)', {}],
  ['module.require(x)', {}],
  ['import.meta.require(x)', {}],
  ['import "fs/promises"', {}],
  ['import "./conformance/helper"', { 'src/engine/conformance/helper.ts': 'readFileSync()' }],
] satisfies [string, Record<string, string>][];

test.each(reviewedForms)("engine reach: review form %s", (source, more) => {
  expect(fixture(source, more).violations.length).toBeGreaterThan(0);
});

test("engine reach: unrelated and locally defined Sync names are intended violations", () => {
  for (const source of ['cache.readFileSync("k")', 'class Engine { stepSync() {} }; new Engine().stepSync()'])
    expect(fixture(source).violations.length).toBeGreaterThan(0);
});

test.each([
  'const r = fs.readFileSync', 'const { "readFileSync": r } = fs',
  'const { wait: w } = Atomics', 'const { binding: b } = process', 'const { which: w } = Bun',
  'process.dlopen', 'process["getBuiltinModule"]', 'Function("return 1")',
  'const r = import.meta.require', 'class Engine { ["stepSync"]() {} }',
])("engine reach: refuses unused references and named patterns %s", source => {
  expect(fixture(source).violations.length).toBeGreaterThan(0);
  expect(fixture('import "../plan/helper";', { 'src/plan/helper.ts': source }).violations.length).toBeGreaterThan(0);
});

test.each([
  ['process', 'const p = process; p.binding("fs")'],
  ['Bun', 'const b = Bun; b.which("tool")'],
  ['Atomics', 'const A = Atomics; A.wait(a, 0, 1)'],
  ['globalThis', 'const g = globalThis; g["ev" + "al"]("source")'],
])("engine reach: refuses value references to owner %s", (name, source) => {
  expect(fixture(source).violations.length).toBeGreaterThan(0);
  expect(fixture('import "../plan/helper";', { 'src/plan/helper.ts': source }).violations.length).toBeGreaterThan(0);
  expect(fixture(`// ${name}\nconst text = "${name}"; const template = \`${name}\`; other.${name}; const o = { ${name}: 1 }; type T = ${name}; type U = typeof ${name}; type V = typeof ${name}.member;`).violations).toEqual([]);
});

test("engine reach: Function type and unrelated eval property are intended violations", () => {
  for (const source of ['type Callback = Function', 'unrelated.eval'])
    expect(fixture(source).violations.length).toBeGreaterThan(0);
});

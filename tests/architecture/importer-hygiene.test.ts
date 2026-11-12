// P1.4b: no tracked file reaches a moved name through its legacy path. Rule and scope: scripts/dev/importers.ts.
// Out of scope: specifiers the checker cannot see statically (no corpus case is one); the last rows pin that limit.
import { expect, test } from "bun:test";
import path from "node:path";
import { analyzeImporters, makeProgram, repoAnalysis } from "../../scripts/dev/importers.js";
import { ROOT } from "../../scripts/dev/boundaries.js";

test("no tracked file reaches a moved name through a legacy path", () => {
  expect(repoAnalysis().violations).toEqual([]);
});

test("the checker finds the names phase 1 moved, and not a wrapper that adds behaviour", () => {
  const { moved } = repoAnalysis();
  expect(moved.get("src/renderers/voicelayer-qwen3.ts")?.get("renderSegment")?.homes).toEqual(["src/pipelines/job-render/index.ts"]);
  expect(moved.get("bin/local-tts-runner.ts")?.get("splitForBreathing")?.homes).toEqual(["src/plan/breathing.ts"]);
  expect(moved.get("src/service.ts")?.has("listJobIds")).toBe(false); // supplies its own default argument
});

// Each case is a directory: impl.ts (the new home), legacy.ts (a frozen legacy module), caller.ts (the importer),
// sometimes mid.ts/mid2.ts. Expected entries are "<file> <names>". Every case with a violation also runs as a
// control without its scratch files (caller.ts unless named), which must be clean.
const IMPL = `export function detectSilences(...a: number[]) { return a.length; }\nexport class Det {}\nexport type T = { a: 1 };\nexport default function parse() { return 2; }\n`;
const SOL_IMPL = `export function f(...a: number[]) { return a.length; }\nexport class X {}\nexport type T = { n: number };\nexport default f;\n`;
const NS = `import * as impl from "./impl.js";\n`;
const STAR = `export * from "./impl.js";\n`;
const DS = `import { detectSilences } from "./legacy.js";\nexport const n = detectSilences();\n`;
const TC = `import type { T } from "./legacy.js";\nexport type N = T;\n`;
const SF = `import { f } from "./legacy.js";\nexport const n = f;\n`;
const ROUND = `import { detectSilences, Det } from "./legacy.js";\nimport type { T } from "./legacy.js";\nexport const n: T | number = detectSilences(Det.length);\n`;
type Case = { legacy?: string; caller?: string; mid?: string; mid2?: string; impl?: string; expect: string[]; scratch?: string[] };
const sol = (c: Case): Case => ({ impl: SOL_IMPL, ...c });

const CASES: Record<string, Case> = {
  // Claude reviewer, PR #43 round 3 (recon/PR43-rv9-r3/attack.ts), A = forwarding forms, L = look-through
  "rv9 A1 export const f = impl.f": { legacy: `${NS}export const detectSilences = impl.detectSilences;\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A2 import {f as g}; export const f = g": { legacy: `import { detectSilences as d } from "./impl.js";\nexport const detectSilences = d;\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A3 wrapper function": { legacy: `${NS}export function detectSilences(...a: []) { return impl.detectSilences(...a); }\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A4 class extends": { legacy: `${NS}export class Det extends impl.Det {}\n`, caller: `import { Det } from "./legacy.js";\nexport const n = new Det();\n`, expect: ["caller.ts Det"] },
  "rv9 A5 export type T = impl.T": { legacy: `import type * as impl from "./impl.js";\nexport type T = impl.T;\n`, caller: TC, expect: ["caller.ts T"] },
  "rv9 A6 import type {T as U}; export type T = U": { legacy: `import type { T as U } from "./impl.js";\nexport type T = U;\n`, caller: TC, expect: ["caller.ts T"] },
  "rv9 A7 interface extends": { legacy: `import type { T as U } from "./impl.js";\nexport interface T2 extends U {}\n`, caller: `import type { T2 } from "./legacy.js";\nexport type N = T2;\n`, expect: ["caller.ts T2"] },
  "rv9 A8 private const then export {}": { legacy: `${NS}const detectSilences = impl.detectSilences;\nexport { detectSilences };\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A9 import ns; export { ns }": { legacy: `${NS}export { impl };\n`, caller: `import { impl } from "./legacy.js";\nexport const n = impl.detectSilences();\n`, expect: ["caller.ts impl"] },
  "rv9 A10 export * as ns": { legacy: `export * as impl from "./impl.js";\n`, caller: `import { impl } from "./legacy.js";\nexport const n = impl.detectSilences();\n`, expect: ["caller.ts impl"] },
  "rv9 A11 export { default } from": { legacy: `export { default } from "./impl.js";\n`, caller: `import parse from "./legacy.js";\nexport const n = parse();\n`, expect: ["caller.ts default"] },
  "rv9 A12 export { default as parse } from": { legacy: `export { default as parse } from "./impl.js";\n`, caller: `import { parse } from "./legacy.js";\nexport const n = parse();\n`, expect: ["caller.ts parse"] },
  "rv9 A13 dynamic import()": { legacy: STAR, caller: `export const n = (await import("./legacy.js")).detectSilences();\n`, expect: ["caller.ts detectSilences"] },
  "rv9 A14 type-only import": { legacy: `export type { T } from "./impl.js";\n`, caller: TC, expect: ["caller.ts T"] },
  "rv9 A15 import(\"…\").T type": { legacy: `export type { T } from "./impl.js";\n`, caller: `export type N = import("./legacy.js").T;\n`, expect: ["caller.ts T"] },
  "rv9 A16 typeof import()": { legacy: STAR, caller: `export type N = typeof import("./legacy.js");\n`, expect: ["caller.ts Det, detectSilences"] },
  "rv9 A17 chain of 2": { legacy: `export * from "./mid.js";\n`, mid: `export { detectSilences } from "./impl.js";\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A18 chain of 3": { legacy: `export * from "./mid.js";\n`, mid: `import { detectSilences } from "./mid2.js";\nexport { detectSilences };\n`, mid2: STAR, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A19 declared + aliased forward": { legacy: `export function own() { return 1; }\nexport { detectSilences as own2 } from "./impl.js";\n`, caller: `import { own, own2 } from "./legacy.js";\nexport const n = [own(), own2()];\n`, expect: ["caller.ts own2"] },
  "rv9 A20 import {f as g}; export { g as f }": { legacy: `import { detectSilences as g } from "./impl.js";\nexport { g as detectSilences };\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A21 export default ns": { legacy: `${NS}export default impl;\n`, caller: `import audio from "./legacy.js";\nexport const n = audio.detectSilences();\n`, expect: ["caller.ts default"] },
  "rv9 A22 export default impl.f": { legacy: `${NS}export default impl.detectSilences;\n`, caller: `import d from "./legacy.js";\nexport const n = d();\n`, expect: ["caller.ts default"] },
  "rv9 A23 export const { f } = impl": { legacy: `${NS}export const { detectSilences } = impl;\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A24 side-effect import of a shim": { legacy: STAR, caller: `import "./legacy.js";\n`, expect: ["caller.ts Det, T, detectSilences"] },
  "rv9 A25 require()": { legacy: STAR, caller: `export const n = require("./legacy.js").detectSilences();\n`, expect: ["caller.ts detectSilences"] },
  "rv9 A26 import = require": { legacy: STAR, caller: `import a = require("./legacy.js");\nexport const n = a.detectSilences();\n`, expect: ["caller.ts detectSilences"] },
  "rv9 A27 legacy uses and forwards": { legacy: `import { detectSilences } from "./impl.js";\nexport { detectSilences };\nexport const own = () => detectSilences();\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A28 import p; export { p as default }": { legacy: `import p from "./impl.js";\nexport { p as default };\n`, caller: `import parse from "./legacy.js";\nexport const n = parse();\n`, expect: ["caller.ts default"] },
  "rv9 A29 export import f = impl.f": { legacy: `${NS}export import detectSilences = impl.detectSilences;\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A30 private type alias then export type {}": { legacy: `import type * as impl from "./impl.js";\ntype T = impl.T;\nexport type { T };\n`, caller: TC, expect: ["caller.ts T"] },
  "rv9 L1 named, behind one forwarder": { legacy: `export const own = 1;\nexport { detectSilences } from "./impl.js";\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 L2 star then named, two forwarders": { legacy: `export * from "./mid.js";\n`, mid: `export { detectSilences } from "./impl.js";\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 L3 namespace import of a forwarder": { legacy: STAR, caller: `import * as f from "./legacy.js";\nexport const x = f;\n`, expect: ["caller.ts Det, detectSilences"] },
  "rv9 L4 wrapper const in a forwarder": { legacy: `${NS}export const detectSilences = impl.detectSilences;\n`, caller: `import { detectSilences } from "./legacy.js";\nexport const x = detectSilences;\n`, expect: ["caller.ts detectSilences"] },
  "rv9 L5 importer uses only the module's own name": { legacy: `export const own = 1;\nexport { x } from "./mid.js";\n`, mid: `export const x = 1;\n`, caller: `import { own } from "./legacy.js";\nexport const y = own;\n`, expect: [] },
  "rv9 L6 forwarded name nobody imports": { legacy: `export { x } from "./mid.js";\n`, mid: `export const x = 1;\n`, expect: [] },
  // Codex reviewer, PR #43 round 3 (recon/pr43-r3-sol/results.json); f, X, T as in its fixture
  "sol round1 legacy becomes export *": { legacy: STAR, caller: ROUND, expect: ["caller.ts Det, detectSilences", "caller.ts T"] },
  "sol round2-semicolon": { legacy: `${STAR};\n`, caller: ROUND, expect: ["caller.ts Det, detectSilences", "caller.ts T"] },
  "sol round2-private-type": { legacy: `${STAR}type Compatibility = unknown;\n`, caller: ROUND, expect: ["caller.ts Det, detectSilences", "caller.ts T"] },
  "sol round2-default": { legacy: `import audio from "./impl.js";\n${STAR}export default audio;\n`, caller: `import parse, { detectSilences } from "./legacy.js";\nexport const n = [parse(), detectSilences()];\n`, expect: ["caller.ts default, detectSilences"] },
  "sol wrapper-const": sol({ legacy: `${NS}export const f = impl.f;\n`, caller: SF, expect: ["caller.ts f"] }),
  "sol wrapper-function": sol({ legacy: `${NS}export function f(...a: number[]) { return impl.f(...a); }\n`, caller: SF, expect: ["caller.ts f"] }),
  "sol wrapper-class": sol({ legacy: `${NS}export class X extends impl.X {}\n`, caller: `import { X } from "./legacy.js";\nexport const n = X;\n`, expect: ["caller.ts X"] }),
  "sol wrapper-type": sol({ legacy: `import type * as impl from "./impl.js";\nexport type T = impl.T;\n`, caller: `import type { T } from "./legacy.js";\nexport const n: T = { n: 1 };\n`, expect: ["caller.ts T"] }),
  "sol namespace-export, upward-namespace": sol({ legacy: `export * as ns from "./impl.js";\n`, caller: `import { ns } from "./legacy.js";\nexport const n = ns.f();\n`, expect: ["caller.ts ns"] }),
  "sol namespace-import-export": sol({ legacy: `import * as ns from "./impl.js";\nexport { ns };\n`, caller: `import { ns } from "./legacy.js";\nexport const n = ns.f();\n`, expect: ["caller.ts ns"] }),
  "sol namespace-import-default": sol({ legacy: `import * as ns from "./impl.js";\nexport default ns;\n`, caller: `import ns from "./legacy.js";\nexport const n = ns.f();\n`, expect: ["caller.ts default"] }),
  "sol default-forward": sol({ legacy: `export { default } from "./impl.js";\n`, caller: `import f from "./legacy.js";\nexport const n = f();\n`, expect: ["caller.ts default"] }),
  "sol dynamic-import": sol({ legacy: `export { f } from "./impl.js";\n`, caller: `const ns = await import("./legacy.js");\nexport const n = ns.f();\n`, expect: ["caller.ts f"] }),
  "sol type-only": sol({ legacy: `export type { T } from "./impl.js";\n`, caller: `import type { T } from "./legacy.js";\nexport const n: T = { n: 1 };\n`, expect: ["caller.ts T"] }),
  "sol namespace-import": sol({ legacy: `export { f } from "./impl.js";\n`, caller: `import * as ns from "./legacy.js";\nexport const n = ns.f();\n`, expect: ["caller.ts f"] }),
  "sol side-effect": sol({ legacy: `export { f } from "./impl.js";\n`, caller: `import "./legacy.js";\n`, expect: ["caller.ts f"] }),
  "sol chain-2, upward-chain-2": sol({ legacy: `export { f } from "./mid.js";\n`, mid: `export { f } from "./impl.js";\n`, caller: SF, expect: ["caller.ts f"] }),
  "sol chain-3": sol({ legacy: `export { f } from "./mid.js";\n`, mid: `export { f } from "./mid2.js";\n`, mid2: `export { f } from "./impl.js";\n`, caller: SF, expect: ["caller.ts f"] }),
  "sol declared-and-alias": sol({ legacy: `export function f() { return 1; }\nexport { f as moved } from "./impl.js";\n`, caller: `import { f, moved } from "./legacy.js";\nexport const n = [f(), moved()];\n`, expect: ["caller.ts moved"] }),
  "sol local-export-list-control": sol({ legacy: `const f = () => 1;\nexport { f };\nexport { X } from "./impl.js";\n`, caller: SF, expect: [] }),
  "sol upward-chain-1": sol({ legacy: `export { f } from "./impl.js";\n`, caller: `import { f } from "./legacy.js";\nexport const n = f();\n`, expect: ["caller.ts f"] }),
  "sol upward-star-import": sol({ legacy: STAR, caller: `import * as ns from "./legacy.js";\nexport const n = ns.f();\n`, expect: ["caller.ts f"] }),
  // Forms the brief names that neither corpus spells out
  "brief chain through a new module": { legacy: STAR, mid: `export * from "./legacy.js";\n`, caller: `import { detectSilences } from "./mid.js";\nexport const n = detectSilences();\n`, expect: ["mid.ts Det, T, detectSilences"], scratch: ["mid.ts", "caller.ts"] },
  "brief re-export from a legacy module": { legacy: STAR, mid: `export { detectSilences } from "./legacy.js";\nexport type { T } from "./legacy.js";\n`, expect: ["mid.ts detectSilences", "mid.ts T"], scratch: ["mid.ts"] },
  "brief require with destructuring": { legacy: STAR, caller: `const { detectSilences } = require("./legacy.js");\nexport const n = detectSilences();\n`, expect: ["caller.ts detectSilences"] },
  "brief inline type specifier": { legacy: STAR, caller: `import { type T } from "./legacy.js";\nexport type N = T;\n`, expect: ["caller.ts T"] },
  "brief generic type alias forward": { impl: `export type G<A> = { v: A };\n`, legacy: `import type { G as H } from "./impl.js";\nexport type G<A> = H<A>;\n`, caller: `import type { G } from "./legacy.js";\nexport type N = G<number>;\n`, expect: ["caller.ts G"] },
  "brief import().then callback": { legacy: STAR, caller: `export const n = import("./legacy.js").then((m) => m.detectSilences());\n`, expect: ["caller.ts detectSilences"] },
  "destructuring a namespace binding reaches only the named keys": { legacy: `export { detectSilences } from "./impl.js";\nexport const own = 1;\n`, caller: `import * as legacy from "./legacy.js";\nconst { own } = legacy;\nexport const n = own;\n`, expect: [] },
  // Not moved: the legacy declaration adds behaviour of its own
  "own default argument": { legacy: `import { detectSilences as d } from "./impl.js";\nexport function detectSilences(n = 1) { return d(n); }\n`, caller: DS, expect: [] },
  "own extra argument": { legacy: `${NS}export function detectSilences(...a: number[]) { return impl.detectSilences(...a, 1); }\n`, caller: DS, expect: [] },
  "own class member": { legacy: `${NS}export class Det extends impl.Det { extra = 1; }\n`, caller: `import { Det } from "./legacy.js";\nexport const n = new Det();\n`, expect: [] },
  "module object as a value cannot reach a moved type": { legacy: `export type { T } from "./impl.js";\nexport const own = 1;\n`, caller: `import * as legacy from "./legacy.js";\nexport const keys = Object.keys(legacy);\n`, expect: [] },
  // Out of scope: deliberate obfuscation no mechanical move writes
  "out of scope: computed import() specifier": { legacy: STAR, caller: "const name = \"legacy\";\nexport const m = await import(`./${name}.js`);\n", expect: [] },
  "out of scope: string-built require path": { legacy: STAR, caller: `export const m = require("./leg" + "acy.js");\n`, expect: [] },
  "out of scope: eval": { legacy: STAR, caller: `export const m = eval('require("./legacy.js")');\n`, expect: [] },
};

const FIXTURE = path.join(ROOT, "dist", ".importer-fixture"); // virtual: these files live only in memory
const dirs = Object.entries(CASES).flatMap(([name, c], i) => {
  const files = Object.fromEntries((["impl", "legacy", "caller", "mid", "mid2"] as const).filter((k) => k === "impl" || c[k] !== undefined).map((k) => [`${k}.ts`, k === "impl" ? c.impl ?? IMPL : c[k]!]));
  const control = Object.fromEntries(Object.entries(files).filter(([f]) => !(c.scratch ?? ["caller.ts"]).includes(f)));
  return [{ dir: `case${i}`, name, files, expect: c.expect }, ...(c.expect.length ? [{ dir: `case${i}-control`, name: `${name} (control)`, files: control, expect: [] }] : [])];
});
const memory = Object.fromEntries(dirs.flatMap((d) => Object.entries(d.files).map(([f, text]) => [path.join(FIXTURE, d.dir, f), text])));
const result = analyzeImporters(makeProgram(Object.keys(memory), memory), dirs.map((d) => `${d.dir}/legacy.ts`), dirs.flatMap((d) => Object.keys(d.files).map((f) => `${d.dir}/${f}`)), FIXTURE);
const found = (dir: string) => result.violations.filter((v) => v.startsWith(`${dir}/`)).map((v) => v.replace(/^[^/]+\/(\S+):\d+ reaches (.+) through .*$/, "$1 $2"));

test.each(dirs.map((d) => [d.name, d] as const))("%s", (_name, d) => {
  expect(found(d.dir)).toEqual(d.expect);
});

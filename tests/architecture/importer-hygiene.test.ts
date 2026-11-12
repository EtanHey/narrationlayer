// P1.4b: no tracked source file reaches a moved name through its legacy path. Rule, definition (lead ruling R1) and
// scope: scripts/dev/importers.ts. Rows marked "own declaration (lead ruling R1)" are wrappers the rule leaves alone.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyzeImporters, importClosure, makeProgram, repoAnalysis, SOURCE_FILE } from "../../scripts/dev/importers.js";
import { ROOT } from "../../scripts/dev/boundaries.js";

test("no tracked file reaches a moved name through a legacy path, and every file and frozen module was analysed", () => {
  const { violations, errors } = repoAnalysis();
  expect(errors).toEqual([]);
  expect(violations).toEqual([]);
});

test("every tracked source extension is scanned (R2)", () => {
  expect(["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "a.d.ts", "a.json", "a.py"].filter((f) => SOURCE_FILE.test(f))).toEqual(["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "a.d.ts"]);
});

test("the checker finds the names phase 1 moved, and not a wrapper that adds behaviour", () => {
  const { moved } = repoAnalysis();
  const at = (f: string) => moved.get(path.join(ROOT, f));
  expect(at("src/renderers/voicelayer-qwen3.ts")?.get("renderSegment")?.homes).toEqual(["src/pipelines/job-render/index.ts"]);
  expect(at("bin/local-tts-runner.ts")?.get("splitForBreathing")?.homes).toEqual(["src/plan/breathing.ts"]);
  expect(at("src/narration-plan.ts")?.get("planNarrationUtterances")?.homes).toEqual(["src/plan/utterances.ts"]);
  expect(at("src/service.ts")?.has("listJobIds")).toBe(false); // a function: the module's own declaration
});

// Each case is a directory: impl.ts (the new home), legacy.ts (a frozen legacy module), caller.ts (the importer),
// sometimes mid.ts/mid2.ts or other `files`. Expected entries: "<file> <names>" (a violation), "<file> unresolved <spec>",
// "<file> unrecognised loader", "legacy not in program", "legacy no module symbol". Every case with an expectation also
// runs as a control without its scratch files (default: files named caller.*), which keeps only the legacy-module errors.
const IMPL = `export function detectSilences(...a: number[]) { return a.length; }\nexport class Det {}\nexport type T = { a: 1 };\nexport default function parse() { return 2; }\n`;
const SOL_IMPL = `export function f(...a: number[]) { return a.length; }\nexport class X {}\nexport type T = { n: number };\nexport default f;\n`;
const NS = `import * as impl from "./impl.js";\n`;
const STAR = `export * from "./impl.js";\n`;
const DS = `import { detectSilences } from "./legacy.js";\nexport const n = detectSilences();\n`;
const TC = `import type { T } from "./legacy.js";\nexport type N = T;\n`;
const SF = `import { f } from "./legacy.js";\nexport const n = f;\n`;
const ROUND = `import { detectSilences, Det } from "./legacy.js";\nimport type { T } from "./legacy.js";\nexport const n: T | number = detectSilences(Det.length);\n`;
type Case = { legacy?: string; caller?: string; mid?: string; mid2?: string; impl?: string; files?: Record<string, string>; expect: string[]; scratch?: string[] };
const sol = (c: Case): Case => ({ impl: SOL_IMPL, ...c });
// Codex reviewer, PR #59 round 1 (recon/PR59-rv25/attack.ts and cursor-attacks.ts), with their fixtures
const RV_IMPL = `export function f(...a: number[]) { return a.length; }\nexport type T = { n: number };\nexport class C {}\nexport default f;\n`;
const RV_NAMED = `import { f } from "./legacy.js"; export const n = f(1);\n`;
const rv = (files: Record<string, string>, expect: string[], scratch?: string[]): Case => ({ impl: RV_IMPL, legacy: STAR, files, expect, scratch });
const CU_IMPL = `export function f() { return 1; } export type T = { n: number };\n`;
const cu = (caller: string, expect: string[], legacy: string | null = `export { f, type T } from "./impl.js";\n`): Case => ({ impl: CU_IMPL, legacy: legacy ?? undefined, caller, expect });

const CASES: Record<string, Case> = {
  // Claude reviewer, PR #43 round 3 (recon/PR43-rv9-r3/attack.ts), A = forwarding forms, L = look-through
  "rv9 A1 export const f = impl.f": { legacy: `${NS}export const detectSilences = impl.detectSilences;\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A2 import {f as g}; export const f = g": { legacy: `import { detectSilences as d } from "./impl.js";\nexport const detectSilences = d;\n`, caller: DS, expect: ["caller.ts detectSilences"] },
  "rv9 A3 wrapper function": { legacy: `${NS}export function detectSilences(...a: []) { return impl.detectSilences(...a); }\n`, caller: DS, expect: [] }, // own declaration (lead ruling R1)
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
  "rv9 A23 export const { f } = impl": { legacy: `${NS}export const { detectSilences } = impl;\n`, caller: DS, expect: [] }, // own declaration (lead ruling R1)
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
  "sol wrapper-function": sol({ legacy: `${NS}export function f(...a: number[]) { return impl.f(...a); }\n`, caller: SF, expect: [] }), // own declaration (lead ruling R1)
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
  "brief generic type alias forward": { impl: `export type G<A> = { v: A };\n`, legacy: `import type { G as H } from "./impl.js";\nexport type G<A> = H<A>;\n`, caller: `import type { G } from "./legacy.js";\nexport type N = G<number>;\n`, expect: [] }, // own declaration (lead ruling R1)
  "brief import().then callback": { legacy: STAR, caller: `export const n = import("./legacy.js").then((m) => m.detectSilences());\n`, expect: ["caller.ts detectSilences"] },
  "destructuring a namespace binding reaches only the named keys": { legacy: `export { detectSilences } from "./impl.js";\nexport const own = 1;\n`, caller: `import * as legacy from "./legacy.js";\nconst { own } = legacy;\nexport const n = own;\n`, expect: [] },
  // Not moved: the legacy declaration adds behaviour of its own
  "own default argument": { legacy: `import { detectSilences as d } from "./impl.js";\nexport function detectSilences(n = 1) { return d(n); }\n`, caller: DS, expect: [] },
  "own extra argument": { legacy: `${NS}export function detectSilences(...a: number[]) { return impl.detectSilences(...a, 1); }\n`, caller: DS, expect: [] },
  "own class member": { legacy: `${NS}export class Det extends impl.Det { extra = 1; }\n`, caller: `import { Det } from "./legacy.js";\nexport const n = new Det();\n`, expect: [] },
  "module object as a value cannot reach a moved type": { legacy: `export type { T } from "./impl.js";\nexport const own = 1;\n`, caller: `import * as legacy from "./legacy.js";\nexport const keys = Object.keys(legacy);\n`, expect: [] },
  "R1 generic alias with no type arguments": { legacy: `import type { T as U } from "./impl.js";\nexport type T<A = string> = U;\n`, caller: TC, expect: [] }, // own declaration (lead ruling R1)
  "brief exported import() type alias (the src/schema.ts idiom)": { legacy: `export type T = import("./impl.js").T;\n`, caller: TC, expect: ["caller.ts T"] },
  "R5 backstop: an unknown loader with a literal path": { legacy: STAR, caller: `declare function load(p: string): any;\nexport const n = load("./legacy.js").detectSilences();\n`, expect: ["caller.ts unrecognised loader"] },
  "R5 backstop: new with a literal path": { legacy: STAR, caller: `declare class Loader { constructor(p: string); }\nexport const n = new Loader("./legacy.js");\n`, expect: ["caller.ts unrecognised loader"] },
  "R5 aliased createRequire import falls to the backstop": { legacy: STAR, caller: `import { createRequire as cr } from "node:module";\nexport const n = cr(import.meta.url)("./legacy.js").detectSilences();\n`, expect: ["caller.ts unrecognised loader"] },
  "R1 ambient empty class forward": { legacy: `${NS}export declare class Det extends impl.Det {}\n`, caller: `import { Det } from "./legacy.js";\nexport const n = Det;\n`, expect: ["caller.ts Det"] },
  "R5 module.createRequire": { legacy: STAR, caller: `import module from "node:module";\nexport const n = module.createRequire(import.meta.url)("./legacy.js").detectSilences();\n`, expect: ["caller.ts detectSilences"] },
  "R2 tracked .d.ts re-export": { legacy: STAR, files: { "caller.d.ts": `export type { T } from "./legacy.js";\n` }, expect: ["caller.d.ts T"] },
  "R2 .cjs require": { legacy: STAR, files: { "caller.cjs": `module.exports = require("./legacy.js").detectSilences;\n` }, expect: ["caller.cjs detectSilences"] },
  "rv25 three-hop-renames": rv({ "legacy.ts": `export { c as f } from "./mid.js";\n`, "mid.ts": `export { b as c } from "./mid2.js";\n`, "mid2.ts": `export { f as b } from "./impl.js";\n`, "caller.ts": RV_NAMED }, ["caller.ts f"]),
  "rv25 export-star-as-namespace": rv({ "legacy.ts": `export * as ns from "./impl.js";\n`, "caller.ts": `import { ns } from "./legacy.js"; export const n = ns.f();\n` }, ["caller.ts ns"]),
  "rv25 mixed-inline-type-value": rv({ "caller.ts": `import { type T, f } from "./legacy.js"; export const n: T = { n: f() };\n` }, ["caller.ts T, f"]),
  "rv25 import-equals-require": rv({ "caller.ts": `import ns = require("./legacy.js"); export const n = ns.f();\n` }, ["caller.ts f"]),
  "rv25 default-named-default-chain": rv({ "legacy.ts": `export { f as default } from "./mid.js";\n`, "mid.ts": `export { default as f } from "./impl.js";\n`, "caller.ts": `import f from "./legacy.js"; export const n = f();\n` }, ["caller.ts default"]),
  "rv25 barrel-index-forwards-legacy": rv({ "dir/index.ts": `export { f } from "../legacy.js";\n`, "caller.ts": `import { f } from "./dir/index.js"; export const n = f();\n` }, ["dir/index.ts f"], ["dir/index.ts", "caller.ts"]),
  "rv25 js-specifier": rv({ "caller.ts": RV_NAMED }, ["caller.ts f"]),
  "rv25 extensionless-specifier": rv({ "caller.ts": `import { f } from "./legacy"; export const n = f();\n` }, ["caller.ts f"]),
  "rv25 typeof-import-type": rv({ "caller.ts": `export type N = typeof import("./legacy.js");\n` }, ["caller.ts C, f"]),
  "rv25 JSDoc-type-in-ts (TypeScript ignores JSDoc types in .ts)": rv({ "caller.ts": `/** @type {import("./legacy.js").T} */\nexport const n = { n: 1 };\n` }, []),
  "rv25 template-without-substitutions": rv({ "caller.ts": "export const n = (await import(`./legacy.js`)).f();\n" }, ["caller.ts f"]),
  "rv25 const-string-dynamic-import (out of scope: specifier held in a variable)": rv({ "caller.ts": `const spec = "./legacy.js"; export const n = (await import(spec)).f();\n` }, []),
  "rv25 destructured-awaited-import": rv({ "caller.ts": `const { f: g } = await import("./legacy.js"); export const n = g();\n` }, ["caller.ts f"]),
  "rv25 namespace-alias": rv({ "caller.ts": `import * as ns from "./legacy.js"; const alias = ns; export const n = alias.f();\n` }, ["caller.ts f"]),
  "rv25 class-extends-forwarded": rv({ "caller.ts": `import { C } from "./legacy.js"; export class D extends C {}\n` }, ["caller.ts C"]),
  "rv25 merged-interface-across-modules": rv({ "impl.ts": `export interface T { n: number }\n`, "augment.ts": `import "./impl.js"; declare module "./impl.js" { interface T { m: number } }\n`, "caller.ts": `import type { T } from "./legacy.js"; export const n: T = { n: 1, m: 2 };\n` }, ["caller.ts T"]),
  "rv25 scripts-file": rv({ "scripts/caller.ts": `import { f } from "../legacy.js"; export const n = f();\n` }, ["scripts/caller.ts f"]),
  "rv25 bin-file": rv({ "bin/caller.ts": `import { f } from "../legacy.js"; export const n = f();\n` }, ["bin/caller.ts f"]),
  "rv25 tsx-file": rv({ "caller.tsx": RV_NAMED }, ["caller.tsx f"]),
  "rv25 mts-file": rv({ "caller.mts": RV_NAMED }, ["caller.mts f"]),
  "rv25 new-entry-module-own-directory": rv({ "new/index.ts": `export { f } from "./impl.js";\n`, "new/impl.ts": `export const f = () => 1;\n`, "caller.ts": `import { f } from "./new/index.js"; export const n = f();\n` }, []),
  "rv25 new-shim-repointed": rv({ "caller.ts": `import { f } from "./impl.js"; export const n = f();\n` }, []),
  "rv25 new-shim-unrepointed": rv({ "caller.ts": RV_NAMED }, ["caller.ts f"]),
  "rv25 fixtures-directory": rv({ "tests/fixtures/caller.ts": `import { f } from "../../legacy.js"; export const n = f();\n` }, ["tests/fixtures/caller.ts f"]),
  "rv25 wrapper-local-result": rv({ "legacy.ts": `import { f as g } from "./impl.js"; export function f(...a: number[]) { const result = g(...a); return result; }\n`, "caller.ts": RV_NAMED }, []), // own declaration (lead ruling R1)
  "rv25 wrapper-expression-bodied-default-arrow": rv({ "legacy.ts": `import { f } from "./impl.js"; export default (...a: number[]) => f(...a);\n`, "caller.ts": `import f from "./legacy.js"; export const n = f();\n` }, []), // own declaration (lead ruling R1)
  "rv25 wrapper-bracket-callee": rv({ "legacy.ts": `import * as impl from "./impl.js"; export function f(...a: number[]) { return impl["f"](...a); }\n`, "caller.ts": RV_NAMED }, []), // own declaration (lead ruling R1)
  "rv25 wrapper-void-statement": rv({ "impl.ts": `export function f(...a: number[]): void {}\n`, "legacy.ts": `import { f as g } from "./impl.js"; export function f(...a: number[]): void { g(...a); }\n`, "caller.ts": RV_NAMED }, []), // own declaration (lead ruling R1)
  "rv25 async-wrapper-adds-promise": rv({ "legacy.ts": `import { f as g } from "./impl.js"; export async function f(...a: number[]) { return g(...a); }\n`, "caller.ts": RV_NAMED }, []),
  "rv25 generator-wrapper-adds-iterator": rv({ "legacy.ts": `import { f as g } from "./impl.js"; export function* f(...a: number[]) { return g(...a); }\n`, "caller.ts": RV_NAMED }, []),
  "rv25 type-alias-adds-default": rv({ "impl.ts": `export type G<A> = { v: A };\n`, "legacy.ts": `import type { G } from "./impl.js"; export type T<A = string> = G<A>;\n`, "caller.ts": `import type { T } from "./legacy.js"; export const n: T = { v: "ok" };\n` }, []),
  "rv25 type-alias-adds-constraint": rv({ "impl.ts": `export type G<A> = { v: A };\n`, "legacy.ts": `import type { G } from "./impl.js"; export type T<A extends string> = G<A>;\n`, "caller.ts": `import type { T } from "./legacy.js"; export const n: T<"ok"> = { v: "ok" };\n` }, []),
  "rv25 wrapper-default-argument-control": rv({ "legacy.ts": `import { f as g } from "./impl.js"; export function f(a = 1) { return g(a); }\n`, "caller.ts": RV_NAMED }, []),
  "rv25 js-value-import": rv({ "caller.js": RV_NAMED }, ["caller.js f"]),
  "rv25 js-JSDoc-import-type": rv({ "caller.js": `/** @type {import("./legacy.js").T} */\nexport const n = { n: 1 };\n` }, ["caller.js T"]),
  "rv25 parenthesized-require": cu(`export const n = (require)("./legacy.js").f();\n`, ["caller.ts f"]),
  "rv25 asserted-require": cu(`export const n = (require as NodeJS.Require)("./legacy.js").f();\n`, ["caller.ts f"]),
  "rv25 createRequire-direct-call": cu(`import { createRequire } from "node:module"; export const n = createRequire(import.meta.url)("./legacy.js").f();\n`, ["caller.ts f"]),
  "rv25 createRequire-local-alias": cu(`import { createRequire } from "node:module"; const load = createRequire(import.meta.url); export const n = load("./legacy.js").f();\n`, ["caller.ts f"]),
  "rv25 require-call": cu(`export const n = require.call(null, "./legacy.js").f();\n`, ["caller.ts f"]),
  "rv25 require-apply": cu(`export const n = require.apply(null, ["./legacy.js"]).f();\n`, ["caller.ts f"]),
  "rv25 bare-require-control": cu(`export const n = require("./legacy.js").f();\n`, ["caller.ts f"]),
  "rv25 unresolved-named-import": cu(`import { f } from "./missing-legacy.js"; export const n = f();\n`, ["caller.ts unresolved ./missing-legacy.js"]),
  "rv25 unresolved-lazy-require": cu(`export const load = () => require("./missing-legacy.js").f();\n`, ["caller.ts unresolved ./missing-legacy.js"]),
  "rv25 missing-frozen-module": cu(`export const load = () => require("./legacy.js").f();\n`, ["caller.ts unresolved ./legacy.js", "legacy not in program"], null),
  "rv25 symbol-less-frozen-module": cu(`export const load = () => require("./legacy.js").f();\n`, ["legacy no module symbol"], `const privateValue = 1;\n`),
  "rv25 template-import-type (out of scope: invalid TypeScript, tsc says String literal expected)": cu("export type T = import(`./legacy.js`).T;\n", []),
  // Out of scope: deliberate obfuscation no mechanical move writes
  "out of scope: computed import() specifier": { legacy: STAR, caller: "const name = \"legacy\";\nexport const m = await import(`./${name}.js`);\n", expect: [] },
  "out of scope: string-built require path": { legacy: STAR, caller: `export const m = require("./leg" + "acy.js");\n`, expect: [] },
  "out of scope: eval": { legacy: STAR, caller: `export const m = eval('require("./legacy.js")');\n`, expect: [] },
};

const FIXTURE = path.join(ROOT, "dist", ".importer-fixture"); // virtual: these files live only in memory
const dirs = Object.entries(CASES).flatMap(([name, c], i) => {
  const roles = Object.fromEntries((["impl", "legacy", "caller", "mid", "mid2"] as const).filter((k) => k === "impl" || c[k] !== undefined).map((k) => [`${k}.ts`, k === "impl" ? c.impl ?? IMPL : c[k]!]));
  const files: Record<string, string> = { ...roles, ...c.files };
  const control = Object.fromEntries(Object.entries(files).filter(([f]) => !(c.scratch ? c.scratch.includes(f) : path.basename(f).startsWith("caller."))));
  const kept = c.expect.filter((e) => e.startsWith("legacy "));
  return [{ dir: `case${i}`, name, files, expect: c.expect }, ...(c.expect.length ? [{ dir: `case${i}-control`, name: `${name} (control)`, files: control, expect: kept }] : [])];
});
const memory = Object.fromEntries(dirs.flatMap((d) => Object.entries(d.files).map(([f, text]) => [path.join(FIXTURE, d.dir, f), text])));
const result = analyzeImporters(makeProgram(Object.keys(memory), memory), dirs.map((d) => `${d.dir}/legacy.ts`), dirs.flatMap((d) => Object.keys(d.files).map((f) => `${d.dir}/${f}`)), FIXTURE);
const short = (s: string) => s
  .replace(/^cannot analyse legacy module \S+: it is not in the program$/, "legacy not in program")
  .replace(/^cannot analyse legacy module \S+: it has no module symbol.*$/, "legacy no module symbol")
  .replace(/^cannot analyse [^/]+\/(\S+):\d+: "(.+)" does not resolve to a file$/, "$1 unresolved $2")
  .replace(/^[^/]+\/(\S+):\d+ reaches (.+) through .*$/, "$1 $2")
  .replace(/^[^/]+\/(\S+):\d+ unrecognised loader .*$/, "$1 unrecognised loader")
  .replace(/^[^/]+\/(\S+):\d+ ".*" differs in letter case .*$/, "$1 case");
const found = (dir: string) => [...result.errors, ...result.violations].filter((v) => v.includes(` ${dir}/`) || v.startsWith(`${dir}/`)).map(short);

test.each(dirs.map((d) => [d.name, d] as const))("%s", (_name, d) => {
  expect(found(d.dir)).toEqual(d.expect);
});

// R4 and R3 on real files: letter case and symlinks need a real file system; closures read from disk.
test("a legacy module reached by a symlink or by different letter case is still the legacy path; unresolved closure edges throw", () => {
  mkdirSync(path.join(ROOT, "dist"), { recursive: true }); // dist/ is gitignored
  const dir = mkdtempSync(path.join(ROOT, "dist", ".importer-disk-"));
  try {
    const files: Record<string, string> = {
      "impl.ts": "export const f = () => 1;\n", "legacy.ts": `export { f } from "./impl.js";\n`,
      "via-case.ts": `import { f } from "./LEGACY.js";\nexport const n = f;\n`, "via-link.ts": `import { f } from "./link.js";\nexport const n = f;\n`,
      "r.ts": `export { f } from "./h1.js";\n`, "h1.ts": `export { f } from "./h2.js";\n`, "h2.ts": `export { f } from "./impl.js";\n`,
      "broken.ts": `import "./h1.js";\nexport { x } from "./missing.js";\n`,
    };
    for (const [f, text] of Object.entries(files)) writeFileSync(path.join(dir, f), text);
    symlinkSync("legacy.ts", path.join(dir, "link.ts"));
    const program = makeProgram([...Object.keys(files), "link.ts"].map((f) => path.join(dir, f)));
    const { violations, errors } = analyzeImporters(program, ["legacy.ts"], ["via-case.ts", "via-link.ts"], dir);
    const caseInsensitive = existsSync(path.join(dir, "LEGACY.ts"));
    expect(violations.map((v) => v.replace(/:\d+ /, " ").replace(/ \(.*$/, ""))).toEqual([
      ...(caseInsensitive ? [`via-case.ts "./LEGACY.js" differs in letter case from the tracked path legacy.ts`, "via-case.ts reaches f through legacy legacy.ts"] : []),
      "via-link.ts reaches f through legacy legacy.ts",
    ]);
    expect(errors).toEqual(caseInsensitive ? [] : [`cannot analyse via-case.ts:1: "./LEGACY.js" does not resolve to a file`]);
    expect(importClosure("r.ts", dir)).toEqual(["h1.ts", "h2.ts", "impl.ts", "r.ts"]); // the two-helper renderer chain of rv25
    expect(() => importClosure("broken.ts", dir)).toThrow(`cannot analyse broken.ts: "./missing.js" does not resolve to a file`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

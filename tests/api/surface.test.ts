// The public surface (src/api/index.ts) is frozen in tests/api/surface.snapshot.generated.json: a sha256 over the compiler's own
// declaration output for the front door and every repo .d.ts it reaches, plus per-file hashes and each public name's emitted
// declaration to label a failure. A deliberate change regenerates it: bun scripts/dev/snapshot-surface.ts --update
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { LEDGER_PATH, readJson, ROOT, type Ledger } from "../../scripts/dev/boundaries.js";
import { API_ENTRY, readSurface, SURFACE_PATH, surfaceDiff, type Surface } from "../../scripts/dev/snapshot-surface.js";

const ACCEPT = "If the change is deliberate, run `bun scripts/dev/snapshot-surface.ts --update` and give the reason in the PR.";
const current = readSurface();

test("the public surface matches its snapshot", () => {
  const frozen = readJson<Surface>(SURFACE_PATH);
  const diff = surfaceDiff(frozen, current.surface);
  if (frozen.sha256 !== current.surface.sha256 || diff.length > 0) throw new Error(`the surface snapshot (${API_ENTRY}) does not match:\n${diff.join("\n")}\n${ACCEPT}`);
});

test("every repo type a public declaration names is itself public", () => {
  expect(current.unexported).toEqual([]);
});

test("public declarations name no third-party package type (only public repo types, TypeScript's library, Bun and node: types)", () => {
  expect(current.thirdParty).toEqual([]);
});

test("the front door holds named re-exports only: no declarations, no logic, no export *", () => {
  const sf = ts.createSourceFile(API_ENTRY, readFileSync(path.join(ROOT, API_ENTRY), "utf8"), ts.ScriptTarget.Latest, true);
  const bad = sf.statements.filter((s) => !(ts.isExportDeclaration(s) && s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)));
  expect(bad.map((s) => s.getText(sf).split("\n")[0])).toEqual([]);
});

test("src/api/index.ts is the only api-layer file", () => {
  const ledger = readJson<Ledger>(LEDGER_PATH);
  expect(Object.entries(ledger.files).filter(([, e]) => e.layer === "api").map(([f]) => f)).toEqual([API_ENTRY]);
});

// One baseline and one mutated module; each probe changes one contract dimension the round 1 review showed a printer could lose.
const BASE = `export interface Pub { size: number }
interface Hidden { secret: string }
export function isText(v: unknown): v is string { return typeof v === "string"; }
export function assertText(v: unknown): asserts v is string { if (typeof v !== "string") throw new Error(); }
export function withThis(this: Pub): void {}
export function hiddenThis(this: Hidden): void {}
export interface Dict { readonly [key: string]: number }
export function lit<const T>(v: T): T { return v; }
export interface Out<out T> { get(): T }
export interface In<in T> { set(v: T): void }
export function run(text: string, opts?: Pub): Promise<string[]> { return Promise.resolve([text]); }
export function plain(): number { return 1; }
`;
const MUTATED: [string, string][] = [
  ["v is string { return", "boolean { return"],
  ["asserts v is string", "void"],
  ["this: Pub", "this: Dict"],
  ["readonly [key", "[key"],
  ["<const T>", "<T>"],
  ["<out T>", "<in out T>"],
  ["<in T>", "<in out T>"],
  ["text: string, opts", "text: number, opts"],
  ["size: number", "size: string"],
];
const ENTRY = `export { isText, assertText, withThis, hiddenThis, lit, run, plain, type Pub, type Dict, type Out, type In } from "./types.js";\n`;

test("the snapshot sees what a hand printer lost: predicates, asserts, this, readonly index, const/in/out, export meaning, dependencies", () => {
  mkdirSync(path.join(ROOT, "dist"), { recursive: true }); // dist/ is gitignored
  const dir = mkdtempSync(path.join(ROOT, "dist", ".surface-"));
  const surfaceOf = (types: string, entry = ENTRY) => {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src/types.ts"), types);
    writeFileSync(path.join(dir, "src/api.ts"), entry);
    return readSurface("src/api.ts", dir);
  };
  try {
    const before = surfaceOf(BASE);
    expect(before.unexported).toEqual(["Hidden (named by hiddenThis)"]); // a receiver type is named like any other
    expect(before.thirdParty).toEqual([]);
    expect(before.surface.names.isText).toEqual({ kind: "value", declaration: "// src/types.d.ts\nexport declare function isText(v: unknown): v is string;" });

    const after = surfaceOf(MUTATED.reduce((s, [a, b]) => s.replace(a, b), BASE));
    expect(after.surface.sha256).not.toBe(before.surface.sha256);
    const changed = surfaceDiff(before.surface, after.surface).filter((l) => / changed declaration:/.test(l)).map((l) => l.split(" ")[0]);
    expect(changed).toEqual(["assertText", "Dict", "In", "isText", "lit", "Out", "Pub", "run", "withThis"]);
    expect(surfaceDiff(before.surface, after.surface)).toContain("declarations changed in src/types.d.ts");

    // A type-only re-export keeps its own meaning: same target, kind value -> none, and the front door's declarations change.
    const typeOnly = surfaceOf(BASE, ENTRY.replace("isText,", "type isText,"));
    expect(typeOnly.surface.names.isText.kind).toBe("none");
    expect(surfaceDiff(before.surface, typeOnly.surface)).toEqual(["isText changed kind: value -> none", "declarations changed in src/api.d.ts"]);

    // A dependency-owned type in a public signature fails closed: its inside is not in the hash.
    mkdirSync(path.join(dir, "node_modules/probe-dep"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules/probe-dep/package.json"), `{"name":"probe-dep","types":"index.d.ts"}\n`);
    writeFileSync(path.join(dir, "node_modules/probe-dep/index.d.ts"), "export interface Dep { nested: { field: number } }\n");
    const dep = surfaceOf(`import type { Dep } from "probe-dep";\nexport function reviewProbe(): Dep { return { nested: { field: 1 } }; }\n`, `export { reviewProbe } from "./types.js";\n`);
    expect(dep.thirdParty).toEqual(["reviewProbe names Dep from probe-dep"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The public surface (src/api/index.ts) is frozen in tests/api/surface.snapshot.generated.json: each name, its kind and its
// checker-printed signature, plus a sha256 over them. A deliberate change regenerates it: bun scripts/dev/snapshot-surface.ts --update
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { LEDGER_PATH, readJson, ROOT, type Ledger } from "../../scripts/dev/boundaries.js";
import { API_ENTRY, readSurface, SURFACE_PATH, surfaceDiff, type Surface } from "../../scripts/dev/snapshot-surface.js";

const ACCEPT = "If the change is deliberate, run `bun scripts/dev/snapshot-surface.ts --update` and give the reason in the PR.";
const current = readSurface();

test("the public surface matches its snapshot", () => {
  const diff = surfaceDiff(readJson<Surface>(SURFACE_PATH), current.surface);
  if (diff.length > 0) throw new Error(`the public surface (${API_ENTRY}) changed:\n${diff.join("\n")}\n${ACCEPT}`);
});

test("every repo type a public signature names is itself public", () => {
  expect(current.unexported).toEqual([]);
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

test("the snapshot names the change: a new name, a changed parameter, a change inside a public type, an unexported type", () => {
  mkdirSync(path.join(ROOT, "dist"), { recursive: true }); // dist/ is gitignored
  const dir = mkdtempSync(path.join(ROOT, "dist", ".surface-"));
  const surfaceOf = (types: string, entry: string) => {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src/types.ts"), types);
    writeFileSync(path.join(dir, "src/api.ts"), entry);
    return readSurface("src/api.ts", dir);
  };
  try {
    const types = `export type Mode = "b" | "a";\nexport interface Opts { mode?: Mode; size: number }\nexport interface Hidden { n: number }\nexport function run(text: string, opts?: Opts): Promise<string[]> { return Promise.resolve([text]); }\nexport function leak(): Hidden { return { n: 1 }; }\n`;
    const before = surfaceOf(types, `export { run, type Mode, type Opts } from "./types.js";\n`);
    expect(before.unexported).toEqual([]);
    expect(before.surface.names.run).toEqual({ kind: "value", signature: "(text: string, opts?: Opts | undefined) => Promise<Array<string>>" });
    expect(before.surface.names.Mode.signature).toBe("'a' | 'b'"); // unions print sorted, independent of checker order
    expect(before.surface.names.Opts.signature).toBe("{ mode?: 'a' | 'b' | undefined; size: number; }"); // a literal-union alias beside undefined is inlined by the checker; its change still shows

    const param = surfaceOf(types.replace("text: string, opts", "text: number, opts"), `export { run, type Mode, type Opts } from "./types.js";\n`);
    expect(surfaceDiff(before.surface, param.surface)).toEqual(["run changed signature:\n  was: (text: string, opts?: Opts | undefined) => Promise<Array<string>>\n  now: (text: number, opts?: Opts | undefined) => Promise<Array<string>>"]);
    const member = surfaceOf(types.replace("size: number", "size: string"), `export { run, type Mode, type Opts } from "./types.js";\n`);
    expect(surfaceDiff(before.surface, member.surface)).toEqual(["Opts changed signature:\n  was: { mode?: 'a' | 'b' | undefined; size: number; }\n  now: { mode?: 'a' | 'b' | undefined; size: string; }"]);
    const added = surfaceOf(types, `export { run, leak, type Mode, type Opts } from "./types.js";\n`);
    expect(surfaceDiff(before.surface, added.surface)).toEqual(["added public name leak (value): () => Hidden"]);
    expect(added.unexported).toEqual(["Hidden (named by leak)"]);
    expect(surfaceDiff(before.surface, surfaceOf(types, `export { run, type Mode } from "./types.js";\n`).surface)).toEqual(["removed public name Opts"]);

    // Generic parameters, type arguments of a named generic type, and readonly are part of the signature.
    const generic = `export interface Box<T = string> { readonly v: T }\nexport interface Hidden { n: number }\nexport function wrap<T extends string>(v: T): Box<T> { return { v }; }\nexport function hide(): Box<Hidden> { return { v: { n: 1 } }; }\n`;
    const g = surfaceOf(generic, `export { wrap, hide, type Box } from "./types.js";\n`);
    expect(g.surface.names.wrap.signature).toBe("<T extends string>(v: T) => Box<T>");
    expect(g.surface.names.Box.signature).toBe("<T = string>{ readonly v: T; }");
    expect(g.surface.names.hide.signature).toBe("() => Box<Hidden>");
    expect(g.unexported).toEqual(["Hidden (named by hide)"]);
    const unconstrained = surfaceOf(generic.replace("<T extends string>", "<T>").replace("readonly v", "v"), `export { wrap, hide, type Box } from "./types.js";\n`);
    expect(surfaceDiff(g.surface, unconstrained.surface).map((l) => l.split(":")[0])).toEqual(["Box changed signature", "wrap changed signature"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

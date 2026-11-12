#!/usr/bin/env bun
// Legacy-path freeze for invariant I-A. Writes tests/compat/legacy-paths.manifest.generated.json: every tracked src/**/*.ts and bin/*.ts
// module with each exported name's meaning: value, type or both (a class, an enum, or a const beside a same-named type is both).
// Re-running only adds: a path, name or meaning already frozen is never dropped. Importing a bin is safe: each starts only under import.meta.main.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { readJson, ROOT } from "./boundaries.js";

export const MANIFEST_PATH = path.join(ROOT, "tests/compat/legacy-paths.manifest.generated.json");
export type Meaning = "value" | "type" | "both" | "none"; // none: exported, but neither a runtime value nor a type
export type Manifest = Record<string, Record<string, Meaning>>;

export const LEGACY_MODULE = /^(src\/.*|bin\/[^/]+)(?<!\.d)\.ts$/; // declaration files are not modules
export function legacyModules(): string[] {
  const out = spawnSync("git", ["ls-files", "--cached", "src", "bin"], { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split("\n").filter((f) => LEGACY_MODULE.test(f)).sort();
}

/** Every exported name per module, following re-exports, and whether its resolved symbol is a type (alias, interface, class, enum); a namespace is not. */
export function typeSides(files: string[], root = ROOT): Record<string, Record<string, boolean>> {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  const program = ts.createProgram(files.map((f) => path.join(root, f)), options);
  const checker = program.getTypeChecker();
  const typeLike = (s: ts.Symbol) => !!((s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s).flags & ts.SymbolFlags.Type);
  return Object.fromEntries(
    files.map((f) => {
      const sf = program.getSourceFile(path.join(root, f));
      const symbol = sf ? checker.getSymbolAtLocation(sf) : undefined;
      return [f, Object.fromEntries((symbol ? checker.getExportsOfModule(symbol) : []).map((s) => [s.name, typeLike(s)]))];
    }),
  );
}

/** Value side from the real runtime module, type side from the checker alone (a runtime absence never implies a type). */
export function meanings(types: Record<string, boolean>, runtime: object): Record<string, Meaning> {
  return Object.fromEntries(Object.entries(types).map(([n, t]) => [n, n in runtime ? (t ? "both" : "value") : t ? "type" : "none"]));
}

const sides = (m: Meaning | undefined): string[] => (m === "both" ? ["value", "type"] : m ? [m] : []);
/** Every meaning a frozen name had that it no longer has, including a name that is gone. */
export function lostMeanings(frozen: Record<string, Meaning>, current: Record<string, Meaning>): string[] {
  return Object.entries(frozen).flatMap(([n, m]) => sides(m).filter((s) => !sides(current[n]).includes(s)).map((s) => `${n} lost its ${s} meaning (was ${m}, now ${current[n] ?? "missing"})`));
}

if (import.meta.main) {
  const manifest: Manifest = existsSync(MANIFEST_PATH) ? readJson<Manifest>(MANIFEST_PATH) : {};
  const files = legacyModules();
  const types = typeSides(files);
  for (const f of files) {
    const now = meanings(types[f], await import(path.join(ROOT, f)));
    const merged = { ...manifest[f] };
    for (const [n, m] of Object.entries(now)) merged[n] = new Set([...sides(merged[n]), ...sides(m)]).size === 2 ? "both" : m;
    manifest[f] = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  }
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`wrote ${Object.keys(sorted).length} modules to ${path.relative(ROOT, MANIFEST_PATH)}`);
}

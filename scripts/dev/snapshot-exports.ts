#!/usr/bin/env bun
// Legacy-path freeze for invariant I-A. Writes tests/compat/legacy-paths.manifest.generated.json: every tracked
// src/**/*.ts and bin/*.ts module with its exported names, split into runtime values and type-only names.
// Re-running only adds: a path or name already in the manifest is never dropped.
// Importing a bin module is safe: each bin starts only under `if (import.meta.main)`.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { readJson, ROOT } from "./boundaries.js";

export const MANIFEST_PATH = path.join(ROOT, "tests/compat/legacy-paths.manifest.generated.json");
export type Manifest = Record<string, { values: string[]; types: string[] }>;

export function legacyModules(): string[] {
  const out = spawnSync("git", ["ls-files", "--cached", "src", "bin"], { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split("\n").filter((f) => /^(src\/.*|bin\/[^/]+)\.ts$/.test(f)).sort();
}

/** Every exported name the type checker sees per module, values and types, following re-exports. */
export function checkerExports(files: string[]): Record<string, string[]> {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  const program = ts.createProgram(files.map((f) => path.join(ROOT, f)), options);
  const checker = program.getTypeChecker();
  return Object.fromEntries(
    files.map((f) => {
      const sf = program.getSourceFile(path.join(ROOT, f));
      const symbol = sf ? checker.getSymbolAtLocation(sf) : undefined;
      return [f, symbol ? checker.getExportsOfModule(symbol).map((s) => s.name) : []];
    }),
  );
}

if (import.meta.main) {
  const manifest: Manifest = existsSync(MANIFEST_PATH) ? readJson<Manifest>(MANIFEST_PATH) : {};
  const files = legacyModules();
  const all = checkerExports(files);
  for (const f of files) {
    const values = Object.keys(await import(path.join(ROOT, f)));
    const types = all[f].filter((n) => !values.includes(n));
    const old = manifest[f] ?? { values: [], types: [] };
    manifest[f] = {
      values: [...new Set([...old.values, ...values])].sort(),
      types: [...new Set([...old.types, ...types])].filter((n) => !values.includes(n)).sort(),
    };
  }
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`wrote ${Object.keys(sorted).length} modules to ${path.relative(ROOT, MANIFEST_PATH)}`);
}

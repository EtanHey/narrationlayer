#!/usr/bin/env bun
// Import ratchet for invariant I-D. Maps every import in src/, bin/ and scripts/ through
// tests/architecture/ledger.json and reports layer violations.
//   bun scripts/dev/boundaries.ts            print current violations and their diff to the baseline
//   bun scripts/dev/boundaries.ts --update   rewrite baseline.json; refuses if it would add an entry
//   bun scripts/dev/boundaries.ts --init     write baseline.json only when none exists yet
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const ROOT = path.resolve(import.meta.dir, "..", "..");
export const LEDGER_PATH = path.join(ROOT, "tests/architecture/ledger.json");
export const BASELINE_PATH = path.join(ROOT, "tests/architecture/baseline.json");
const IN_SCOPE = /^(src|bin|scripts)\/.*\.ts$/;

export interface LedgerEntry {
  layer: 0 | 1 | 2 | 3 | 4 | 5 | "api";
  area: string;
  shim?: true;
  entry?: string[];
  owner?: string;
  exempt?: string;
}
export interface Ledger {
  layers: Record<string, string>;
  files: Record<string, LedgerEntry>;
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Tracked plus untracked-but-not-ignored .ts files under src/, bin/ and scripts/. */
export function scopedFiles(): string[] {
  const out = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split("\n").filter((f) => IN_SCOPE.test(f) && existsSync(path.join(ROOT, f))).sort();
}

/** Every module specifier: import, import type, export from, import(), import("…") types, import = require. */
export function importSpecifiers(source: string, fileName = "x.ts"): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]; // a non-literal import() cannot be resolved statically
      if (arg && ts.isStringLiteralLike(arg)) specs.push(arg.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      specs.push(node.argument.literal.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      specs.push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true));
  return specs;
}

/** Repo-relative .ts target of a relative specifier, or null for packages, builtins and non-.ts files. */
export function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.join(path.dirname(from), spec);
  const candidates = [base.replace(/\.(m?js)$/, ".ts"), base, `${base}.ts`, path.join(base, "index.ts")];
  return candidates.find((c) => c.endsWith(".ts") && existsSync(path.join(ROOT, c))) ?? null;
}

const rank = (e: LedgerEntry): number => (e.layer === "api" ? 6 : e.layer);

/**
 * True when a module body is only re-exports: `export … from`, `import` + bare `export { … }`, and
 * `export type X = import("…").X` aliases. One statement of its own code makes it a real module.
 */
export function isReexportOnly(source: string, fileName = "x.ts"): boolean {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const reexport = (s: ts.Statement): boolean =>
    ts.isExportDeclaration(s) ||
    ts.isImportDeclaration(s) ||
    (ts.isTypeAliasDeclaration(s) && ts.isImportTypeNode(s.type) && !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  return sf.statements.some((s) => !ts.isImportDeclaration(s)) && sf.statements.every(reexport);
}

/** Shim status is detected, never declared: a re-export-only file under src/ or bin/ outside the api layer. */
export function isShim(file: string, ledger: Ledger): boolean {
  return /^(src|bin)\//.test(file) && ledger.files[file]?.layer !== "api" && isReexportOnly(readFileSync(path.join(ROOT, file), "utf8"), file);
}

/** Sorted, de-duplicated "<rule> <from> -> <to>" lines for every import that breaks a layer rule. */
export function violations(ledger: Ledger): string[] {
  const found = new Set<string>();
  const files = scopedFiles();
  const shims = new Set(files.filter((f) => isShim(f, ledger)));
  for (const from of files) {
    const src = ledger.files[from];
    if (!src) continue; // reported by ledgerProblems
    for (const spec of importSpecifiers(readFileSync(path.join(ROOT, from), "utf8"), from)) {
      const to = resolveImport(from, spec);
      const dst = to ? ledger.files[to] : undefined;
      if (!to || !dst) continue;
      if (dst.layer === "api") found.add(`via-api ${from} -> ${to}`);
      else if (shims.has(to)) found.add(`via-shim ${from} -> ${to}`);
      else if (shims.has(from) || src.layer === "api") continue; // re-export-only files may point anywhere below
      else if (rank(dst) > rank(src)) found.add(`upward ${from} -> ${to}`);
      else if (src.layer === 2 && dst.layer === 2 && src.area !== dst.area) found.add(`cross-area ${from} -> ${to}`);
    }
  }
  return [...found].sort();
}

/** Hard failures that no baseline can hold: ledger gaps, stale rows, malformed rows, shim flags that disagree with detection. */
export function ledgerProblems(ledger: Ledger): string[] {
  const problems: string[] = [];
  const files = scopedFiles();
  for (const f of files) if (!ledger.files[f]) problems.push(`missing from ledger: ${f}`);
  for (const [f, e] of Object.entries(ledger.files)) {
    if (!files.includes(f)) problems.push(`ledger row for a file that does not exist: ${f}`);
    if (!(e.layer === "api" || [0, 1, 2, 3, 4, 5].includes(e.layer))) problems.push(`bad layer: ${f}`);
    if (!e.owner === !e.exempt) problems.push(`needs exactly one of owner/exempt: ${f}`);
    if (!files.includes(f)) continue;
    const detected = isShim(f, ledger);
    if (detected && !e.shim) problems.push(`re-export-only file is a shim but its ledger row lacks "shim": true: ${f}`);
    if (e.shim && !detected) problems.push(`ledger marks a shim that is not a re-export-only src/ or bin/ file: ${f}`);
    if (e.layer === "api" && !isReexportOnly(readFileSync(path.join(ROOT, f), "utf8"), f)) problems.push(`api file is not re-export-only: ${f}`);
  }
  return problems;
}

/** Entry files must keep every marker the ledger lists (their import.meta.main block, import.meta.dir use). */
export function entryProblems(ledger: Ledger): string[] {
  return Object.entries(ledger.files).flatMap(([f, e]) => {
    const text = existsSync(path.join(ROOT, f)) ? readFileSync(path.join(ROOT, f), "utf8") : "";
    return (e.entry ?? []).filter((marker) => !text.includes(marker)).map((marker) => `${f} lost entry marker: ${marker}`);
  });
}

function writeBaseline(entries: string[]): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(entries, null, 2)}\n`);
}

if (import.meta.main) {
  const ledger = readJson<Ledger>(LEDGER_PATH);
  const current = violations(ledger);
  const flag = process.argv[2];
  if (flag === "--init") {
    if (existsSync(BASELINE_PATH)) throw new Error("baseline.json exists; use --update, which can only shrink it");
    writeBaseline(current);
  } else {
    const baseline = readJson<string[]>(BASELINE_PATH);
    const added = current.filter((v) => !baseline.includes(v));
    const fixed = baseline.filter((v) => !current.includes(v));
    console.log(JSON.stringify({ current, added, fixed }, null, 2));
    if (flag === "--update") {
      if (added.length > 0) {
        console.error(`refusing to add ${added.length} new violation(s) to the baseline; fix them instead`);
        process.exit(1);
      }
      writeBaseline(current);
    }
  }
}

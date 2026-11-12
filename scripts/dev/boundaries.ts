#!/usr/bin/env bun
// Import ratchet for invariant I-D. Every import form in a file under src/, bin/ or scripts/ is one edge from that
// file to the file it names; both ends are mapped through tests/architecture/ledger.json and layer-checked.
// There is no forwarding exemption: a legacy file that re-exports from a new home is checked against that home.
//   bun scripts/dev/boundaries.ts            print current violations and their diff to the baseline
//   bun scripts/dev/boundaries.ts --update   rewrite baseline.json; refuses if it would add an entry
//   bun scripts/dev/boundaries.ts --init     write baseline.json only when none exists yet
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const ROOT = path.resolve(import.meta.dir, "..", "..");
export const LEDGER_PATH = path.join(ROOT, "tests/architecture/ledger.json");
export const BASELINE_PATH = path.join(ROOT, "tests/architecture/baseline.json");
const IN_SCOPE = /^(src|bin|scripts)\/.*\.ts$/;

/** One row per file: layer, area, owner slice XOR exemption; `entry` lists markers an entry file must keep. */
export type LedgerEntry = { layer: 0 | 1 | 2 | 3 | 4 | 5 | "api"; area: string; entry?: string[]; owner?: string; exempt?: string };
export type Ledger = { layers: Record<string, string>; files: Record<string, LedgerEntry> };
/** The files to check and a reader that returns undefined for a path that is not a file. */
export type Repo = { files: string[]; read: (file: string) => string | undefined };

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Tracked .ts files under src/, bin/ and scripts/ of a git checkout (untracked files are not ours to ledger). */
export function diskRepo(root = ROOT): Repo {
  const out = spawnSync("git", ["ls-files", "--cached"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  const isFile = (f: string) => existsSync(path.join(root, f)) && statSync(path.join(root, f)).isFile();
  const files = out.stdout.split("\n").filter((f) => IN_SCOPE.test(f) && isFile(f)).sort();
  return { files, read: (f) => (isFile(f) ? readFileSync(path.join(root, f), "utf8") : undefined) };
}

/** Every module specifier: import, import type, export from, import(), require(), import = require, import("…") type nodes. */
export function importSpecifiers(source: string, fileName = "x.ts"): string[] {
  const specs: string[] = [];
  const literal = (n: ts.Node | undefined) => (n && ts.isStringLiteralLike(n) ? specs.push(n.text) : 0);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) literal(node.arguments[0]); // a non-literal argument cannot be resolved statically
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal(node.argument.literal);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) literal(node.moduleReference.expression);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true));
  return specs;
}

/** Repo-relative target of a relative specifier; null for packages and builtins; "" when no file matches. */
export function resolveImport(repo: Repo, from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.join(path.dirname(from), spec);
  const candidates = [base.replace(/\.(m?js)$/, ".ts"), base, `${base}.ts`, path.join(base, "index.ts")];
  return candidates.find((c) => repo.read(c) !== undefined) ?? "";
}

const rank = (e: LedgerEntry): number => (e.layer === "api" ? 6 : e.layer);

/** Sorted "<rule> <from> -> <to>" layer violations, and the relative imports that resolve to no file. */
export function analyze(ledger: Ledger, repo: Repo = diskRepo()): { violations: string[]; unresolved: string[] } {
  const found = new Set<string>();
  const unresolved = new Set<string>();
  for (const from of repo.files) {
    const src = ledger.files[from];
    if (!src) continue; // reported by ledgerProblems
    for (const spec of importSpecifiers(repo.read(from) ?? "", from)) {
      const to = resolveImport(repo, from, spec);
      if (to === "") unresolved.add(`unresolved import ${from} -> ${spec}`);
      const dst = to ? ledger.files[to] : undefined;
      if (!to || !dst) continue;
      if (dst.layer === "api") found.add(`via-api ${from} -> ${to}`);
      else if (rank(dst) > rank(src)) found.add(`upward ${from} -> ${to}`);
      else if (src.layer === 2 && dst.layer === 2 && src.area !== dst.area) found.add(`cross-area ${from} -> ${to}`);
    }
  }
  return { violations: [...found].sort(), unresolved: [...unresolved].sort() };
}

export const violations = (ledger: Ledger, repo?: Repo): string[] => analyze(ledger, repo).violations;

/** Hard failures that no baseline can hold: ledger gaps, stale or malformed rows, unresolvable relative imports. */
export function ledgerProblems(ledger: Ledger, repo: Repo = diskRepo()): string[] {
  const problems: string[] = [];
  for (const f of repo.files) if (!ledger.files[f]) problems.push(`missing from ledger: ${f}`);
  for (const [f, e] of Object.entries(ledger.files)) {
    if (!repo.files.includes(f)) problems.push(`ledger row for a file that does not exist: ${f}`);
    if (!(e.layer === "api" || [0, 1, 2, 3, 4, 5].includes(e.layer))) problems.push(`bad layer: ${f}`);
    if (!e.owner === !e.exempt) problems.push(`needs exactly one of owner/exempt: ${f}`);
  }
  return [...problems, ...analyze(ledger, repo).unresolved];
}

const squash = (s: string) => s.replace(/\s+/g, "");
/** A marker "if (X)" needs a top-level if statement on condition X; any other marker needs a code node with that text. Comments never count. */
export function hasMarker(source: string, marker: string): boolean {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const condition = /^if \((.*)\)$/.exec(marker)?.[1];
  if (condition) return sf.statements.some((s) => ts.isIfStatement(s) && squash(s.expression.getText(sf)) === squash(condition));
  const visit = (n: ts.Node): boolean => squash(n.getText(sf)) === squash(marker) || (ts.forEachChild(n, visit) ?? false);
  return ts.forEachChild(sf, visit) ?? false;
}

const MAIN = "if (import.meta.main)";
/** Entry files keep every listed marker; any src/ or bin/ file with a top-level import.meta.main block must list it. */
export function entryProblems(ledger: Ledger, repo: Repo = diskRepo()): string[] {
  return Object.entries(ledger.files).flatMap(([f, e]) => {
    const text = repo.read(f) ?? "";
    const unlisted = /^(src|bin)\//.test(f) && !e.entry?.includes(MAIN) && hasMarker(text, MAIN);
    return [...(unlisted ? [`${f} has an import.meta.main block but no entry row`] : []), ...(e.entry ?? []).filter((m) => !hasMarker(text, m)).map((m) => `${f} lost entry marker: ${m}`)];
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

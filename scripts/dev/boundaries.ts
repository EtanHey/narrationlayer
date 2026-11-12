#!/usr/bin/env bun
// Import ratchet for invariant I-D. Every import form in a file under src/, bin/ or scripts/ is one edge from that
// file to the file it names (relative, absolute, or the package's own name through package.json `exports`); both ends are mapped through tests/architecture/ledger.json and layer-checked.
// There is no forwarding exemption: a legacy file that re-exports from a new home is checked against that home.
//   bun scripts/dev/boundaries.ts            print current violations and their diff to the baseline
//   bun scripts/dev/boundaries.ts --update   rewrite baseline.json; refuses if it would add an entry
//   bun scripts/dev/boundaries.ts --init     write baseline.json only when none exists yet
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = path.resolve(import.meta.dir, "..", "..");
export const LEDGER_PATH = path.join(ROOT, "tests/architecture/ledger.json");
export const BASELINE_PATH = path.join(ROOT, "tests/architecture/baseline.json");
const IN_SCOPE = /^(src|bin|scripts)\/.*(?<!\.d)\.ts$/; // declaration files are not modules to ledger

/** One row per file: layer, area, owner slice XOR exemption; `entry` lists markers an entry file must keep. */
export type LedgerEntry = { layer: 0 | 1 | 2 | 3 | 4 | 5 | "api"; area: string; entry?: string[]; owner?: string; exempt?: string; shim?: true };
export type Ledger = { layers: Record<string, string>; files: Record<string, LedgerEntry> };
/** The in-scope files to check, every tracked path (imports resolve only to these, by exact string), a reader, and the
 * checkout's absolute root (for absolute-path specifiers). */
export type Repo = { files: string[]; tracked: Set<string>; read: (file: string) => string | undefined; root?: string };

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Tracked .ts files under src/, bin/ and scripts/ of a git checkout (untracked files are not ours to ledger). */
export function diskRepo(root = ROOT): Repo {
  const out = spawnSync("git", ["ls-files", "--cached"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  const isFile = (f: string) => existsSync(path.join(root, f)) && statSync(path.join(root, f)).isFile();
  const tracked = new Set(out.stdout.split("\n").filter((f) => f && isFile(f)));
  const files = [...tracked].filter((f) => IN_SCOPE.test(f)).sort();
  return { files, tracked, read: (f) => (isFile(f) ? readFileSync(path.join(root, f), "utf8") : undefined), root };
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

/** The repo file the package's own name maps to through package.json `exports` (a self-reference); "" when the name is
 * ours but the subpath is not exported; null when the specifier names another package or a builtin. */
function ownPackageTarget(repo: Repo, spec: string): string | null {
  let pkg: { name?: string; exports?: Record<string, string> };
  try {
    pkg = JSON.parse(repo.read("package.json") ?? "{}");
  } catch {
    return null;
  }
  if (!pkg.name || (spec !== pkg.name && !spec.startsWith(`${pkg.name}/`))) return null;
  const key = spec === pkg.name ? "." : `./${spec.slice(pkg.name.length + 1)}`;
  const target = typeof pkg.exports?.[key] === "string" ? path.normalize(pkg.exports[key]) : "";
  return repo.tracked.has(target) ? target : "";
}

/** Tracked target of a specifier by exact string (so a wrong-case or untracked target is unresolved even on a case-insensitive
 * disk): relative paths, absolute paths and file: URLs into the checkout, and the package's own name through its `exports`.
 * null for other packages and builtins; "" when nothing matches. */
export function resolveImport(repo: Repo, from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = path.join(path.dirname(from), spec);
  else if (spec.startsWith("/") || spec.startsWith("file:")) {
    const abs = spec.startsWith("file:") ? fileURLToPath(spec) : spec;
    const rel = repo.root ? path.relative(repo.root, abs) : "..";
    if (rel.startsWith("..") || path.isAbsolute(rel)) return ""; // outside the checkout: nothing a tracked file may rely on
    base = rel;
  } else return ownPackageTarget(repo, spec);
  const candidates = [base.replace(/\.(m?js)$/, ".ts"), base, `${base}.ts`, path.join(base, "index.ts")];
  return candidates.find((c) => repo.tracked.has(c)) ?? "";
}

const rank = (e: LedgerEntry): number => (e.layer === "api" ? 6 : e.layer);

/** The same parser and resolver supply both layer edges and incoming shim edges. */
function* importEdges(repo: Repo, files: Iterable<string> = repo.files) {
  for (const from of files) {
    for (const spec of importSpecifiers(repo.read(from) ?? "", from)) yield { from, spec, to: resolveImport(repo, from, spec) };
  }
}

/** Sorted "<rule> <from> -> <to>" layer violations, and the hard failures: unresolved imports and imports of unledgered in-scope files. */
export function analyze(ledger: Ledger, repo: Repo = diskRepo()): { violations: string[]; unresolved: string[] } {
  const found = new Set<string>();
  const unresolved = new Set<string>();
  for (const { from, spec, to } of importEdges(repo)) {
    const src = ledger.files[from];
    if (!src) continue; // reported by ledgerProblems
    if (to === "") unresolved.add(`unresolved import ${from} -> ${spec}`);
    if (!to) continue;
    const dst = ledger.files[to];
    if (!dst && IN_SCOPE.test(to)) unresolved.add(`import of an unledgered file ${from} -> ${to}`);
    if (!dst) continue; // tracked targets outside src/, bin/ and scripts/ .ts (package.json, tests/, data files) are not layered
    if (dst.layer === "api") found.add(`via-api ${from} -> ${to}`);
    else if (rank(dst) > rank(src)) found.add(`upward ${from} -> ${to}`);
    else if (src.layer === 2 && dst.layer === 2 && src.area !== dst.area) found.add(`cross-area ${from} -> ${to}`);
  }
  return { violations: [...found].sort(), unresolved: [...unresolved].sort() };
}

export const violations = (ledger: Ledger, repo?: Repo): string[] => analyze(ledger, repo).violations;

/** Shim shape and incoming edges are hard failures, never baseline entries. */
export function shimProblems(ledger: Ledger, repo: Repo = diskRepo()): string[] {
  const problems: string[] = [];
  const sources = [...repo.tracked].filter((f) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f));
  const targets = new Map<string, string[]>();
  for (const file of sources) {
    if (!/^(src|bin)\//.test(file) && !ledger.files[file]?.shim) continue;
    const sf = ts.createSourceFile(file, repo.read(file) ?? "", ts.ScriptTarget.Latest, true);
    const bad = sf.statements.filter((s) => !(ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteralLike(s.moduleSpecifier)));
    if (ledger.files[file]?.shim) {
      if (file === "src/api/index.ts") problems.push(`${file} is the public front door, not a shim`);
      if (!sf.statements.length) problems.push(`${file} shim has no re-export statements`);
      for (const s of bad) problems.push(`${file} shim contains ${ts.SyntaxKind[s.kind]}: ${s.getText(sf)}`);
      targets.set(file, [...new Set(sf.statements.flatMap((s) => {
        if (!ts.isExportDeclaration(s) || !s.moduleSpecifier || !ts.isStringLiteralLike(s.moduleSpecifier)) return [];
        return [resolveImport(repo, file, s.moduleSpecifier.text) || s.moduleSpecifier.text];
      }))]);
    } else if (file !== "src/api/index.ts" && sf.statements.length && !bad.length) {
      problems.push(`${file} is a pure re-export file but has no shim flag`);
    }
  }
  // Compatibility tests alone may import shims: they exercise the frozen legacy paths.
  for (const { from, to } of importEdges(repo, sources)) {
    if (to && ledger.files[to]?.shim && !from.startsWith("tests/compat/")) {
      problems.push(`${from} imports shim ${to}; re-exports from ${(targets.get(to) ?? []).join(", ")}`);
    }
  }
  return [...new Set(problems)].sort();
}

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
const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);
/** A marker "if (X)" needs a top-level if statement on condition X; any other marker needs a code node with that text. Comments never count. */
export function hasMarker(source: string, marker: string): boolean {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const condition = /^if \((.*)\)$/.exec(marker)?.[1];
  if (condition) return sf.statements.some((s) => ts.isIfStatement(s) && squash(unwrap(s.expression).getText(sf)) === squash(condition));
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

if (import.meta.main) {
  const current = violations(readJson<Ledger>(LEDGER_PATH));
  const flag = process.argv[2];
  if (flag === "--init" && existsSync(BASELINE_PATH)) throw new Error("baseline.json exists; use --update, which can only shrink it");
  const baseline = flag === "--init" ? current : readJson<string[]>(BASELINE_PATH);
  const added = current.filter((v) => !baseline.includes(v));
  if (flag !== "--init") console.log(JSON.stringify({ current, added, fixed: baseline.filter((v) => !current.includes(v)) }, null, 2));
  if (flag === "--update" && added.length > 0) {
    console.error(`refusing to add ${added.length} new violation(s) to the baseline; fix them instead`);
    process.exit(1);
  }
  if (flag === "--init" || flag === "--update") writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
}

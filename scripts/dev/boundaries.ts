#!/usr/bin/env bun
// Import ratchet for invariant I-D. Maps every import in src/, bin/ and scripts/ through
// tests/architecture/ledger.json and reports layer violations.
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

/** Tracked plus untracked-but-not-ignored .ts files under src/, bin/ and scripts/, read from disk. */
export function diskRepo(): Repo {
  const out = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  const isFile = (f: string) => existsSync(path.join(ROOT, f)) && statSync(path.join(ROOT, f)).isFile();
  const files = out.stdout.split("\n").filter((f) => IN_SCOPE.test(f) && isFile(f)).sort();
  return { files, read: (f) => (isFile(f) ? readFileSync(path.join(ROOT, f), "utf8") : undefined) };
}

/** One name a file takes from a module ("*" = the whole namespace), and whether the file only forwards it. */
export type Use = { spec: string; name: string; forwardOnly: boolean };
/** exported name -> "local" when this file declares it, else the module and name it forwards. */
type Origin = "local" | { spec: string; name: string };
export type Facts = { uses: Use[]; exports: Map<string, Origin>; stars: string[] };

const hasModifier = (n: ts.Node, kind: ts.SyntaxKind) => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === kind);
const leftmost = (q: ts.EntityName): string => (ts.isIdentifier(q) ? q.text : leftmost(q.left));
const typeRef = (t: ts.TypeNode) => (ts.isImportTypeNode(t) && !t.isTypeOf && t.qualifier && ts.isLiteralTypeNode(t.argument) && ts.isStringLiteral(t.argument.literal) ? { spec: t.argument.literal.text, name: leftmost(t.qualifier) } : undefined);
const bindingNames = (b: ts.BindingName): string[] => (ts.isIdentifier(b) ? [b.text] : b.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name))));

/** Every import form (import, import type, export from, import(), import("…") types, import = require, require()) and every export. */
export function moduleFacts(source: string, fileName = "x.ts"): Facts {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const imported = new Map<string, { spec: string; name: string; id: ts.Identifier }>();
  const exports = new Map<string, Origin>();
  const stars: string[] = [];
  const uses: Use[] = [];
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const spec = s.moduleSpecifier.text;
      const clause = s.importClause;
      const nb = clause?.namedBindings;
      if (!clause || (nb && ts.isNamespaceImport(nb))) uses.push({ spec, name: "*", forwardOnly: false });
      if (clause?.name) imported.set(clause.name.text, { spec, name: "default", id: clause.name });
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) imported.set(e.name.text, { spec, name: (e.propertyName ?? e.name).text, id: e.name });
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
      const spec = s.moduleSpecifier.text;
      if (!s.exportClause) stars.push(spec);
      else if (ts.isNamespaceExport(s.exportClause)) exports.set(s.exportClause.name.text, { spec, name: "*" });
      else for (const e of s.exportClause.elements) exports.set(e.name.text, { spec, name: (e.propertyName ?? e.name).text });
      uses.push({ spec, name: "*", forwardOnly: true });
    } else if (ts.isTypeAliasDeclaration(s) && typeRef(s.type)) {
      if (hasModifier(s, ts.SyntaxKind.ExportKeyword)) exports.set(s.name.text, typeRef(s.type)!);
      else imported.set(s.name.text, { ...typeRef(s.type)!, id: s.name });
    } else if (hasModifier(s, ts.SyntaxKind.ExportKeyword)) {
      const named = (s as ts.DeclarationStatement).name;
      const names = ts.isVariableStatement(s) ? s.declarationList.declarations.flatMap((d) => bindingNames(d.name)) : [hasModifier(s, ts.SyntaxKind.DefaultKeyword) || !named ? "default" : named.text];
      for (const n of names) exports.set(n, "local");
    }
  }
  // Forwarding exports of names this file imported: export { x }, export default x.
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const e of s.exportClause.elements) {
        const via = imported.get((e.propertyName ?? e.name).text);
        exports.set(e.name.text, via ? { spec: via.spec, name: via.name } : "local");
      }
    } else if (ts.isExportAssignment(s)) {
      const via = ts.isIdentifier(s.expression) ? imported.get(s.expression.text) : undefined;
      exports.set("default", via ? { spec: via.spec, name: via.name } : "local");
    }
  }
  // An imported binding only forwards when every reference to it sits in an export.
  const refs = new Map<string, boolean[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && imported.has(node.text) && imported.get(node.text)!.id !== node) {
      const p = node.parent;
      refs.set(node.text, [...(refs.get(node.text) ?? []), (ts.isExportSpecifier(p) && !p.parent.parent.moduleSpecifier) || ts.isExportAssignment(p)]);
    }
    if (ts.isImportTypeNode(node) && !(ts.isTypeAliasDeclaration(node.parent) && node.parent.type === node && typeRef(node))) {
      const literal = ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) ? node.argument.literal.text : undefined;
      if (literal) uses.push({ spec: literal, name: typeRef(node)?.name ?? "*", forwardOnly: false });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const arg = node.arguments[0]; // a non-literal import() cannot be resolved statically
      if (arg && ts.isStringLiteralLike(arg)) uses.push({ spec: arg.text, name: "*", forwardOnly: false });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      uses.push({ spec: node.moduleReference.expression.text, name: "*", forwardOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const [local, via] of imported) {
    const r = refs.get(local) ?? [];
    uses.push({ spec: via.spec, name: via.name, forwardOnly: r.length > 0 && r.every(Boolean) });
  }
  return { uses, exports, stars };
}

/** Repo-relative target of a relative specifier; null for packages and builtins; "" when no file matches. */
export function resolveImport(repo: Repo, from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.join(path.dirname(from), spec);
  const candidates = [base.replace(/\.(m?js)$/, ".ts"), base, `${base}.ts`, path.join(base, "index.ts")];
  return candidates.find((c) => repo.read(c) !== undefined) ?? "";
}

const rank = (e: LedgerEntry): number => (e.layer === "api" ? 6 : e.layer);

/**
 * Layer rules plus the name rule: importing name N from module T is `via-reexport` unless T declares N itself.
 * Forward-only uses (the legacy path re-exporting from the new home) and api importers are exempt; layer rules
 * also apply to the module that really declares a forwarded name.
 */
export function analyze(ledger: Ledger, repo: Repo = diskRepo()): { violations: string[]; unresolved: string[] } {
  const found = new Set<string>();
  const unresolved = new Set<string>();
  const cache = new Map<string, Facts>();
  const facts = (f: string) => cache.get(f) ?? cache.set(f, moduleFacts(repo.read(f) ?? "", f)).get(f)!;
  const declarer = (file: string, name: string, seen = new Set<string>()): string | null => {
    if (seen.has(`${file}#${name}`)) return null;
    seen.add(`${file}#${name}`);
    const { exports, stars } = facts(file);
    const o = exports.get(name);
    if (o === "local") return file;
    const next = (spec: string, n: string) => {
      const m = resolveImport(repo, file, spec);
      return m?.endsWith(".ts") ? (n === "*" ? m : declarer(m, n, seen)) : null;
    };
    if (o) return next(o.spec, o.name);
    for (const s of stars) {
      const d = next(s, name);
      if (d) return d;
    }
    return null;
  };
  const edge = (from: string, src: LedgerEntry, to: string) => {
    const dst = ledger.files[to];
    if (!dst) return;
    if (rank(dst) > rank(src)) found.add(`upward ${from} -> ${to}`);
    else if (src.layer === 2 && dst.layer === 2 && src.area !== dst.area) found.add(`cross-area ${from} -> ${to}`);
  };
  for (const from of repo.files) {
    const src = ledger.files[from];
    if (!src) continue; // reported by ledgerProblems
    for (const use of facts(from).uses) {
      const to = resolveImport(repo, from, use.spec);
      if (to === "") unresolved.add(`unresolved import ${from} -> ${use.spec}`);
      if (!to || !ledger.files[to]) continue;
      if (ledger.files[to].layer === "api") found.add(`via-api ${from} -> ${to}`);
      if (use.forwardOnly || ledger.files[to].layer === "api") continue;
      edge(from, src, to);
      if (src.layer === "api") continue;
      const t = facts(to);
      const forwarded = use.name === "*" ? t.stars.length > 0 || [...t.exports.values()].some((o) => o !== "local") : t.exports.get(use.name) !== "local" && (t.exports.has(use.name) || t.stars.length > 0);
      if (!forwarded) continue;
      found.add(`via-reexport ${from} -> ${to} (${use.name})`);
      const real = use.name === "*" ? null : declarer(to, use.name);
      if (real && real !== to) edge(from, src, real);
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

/** Entry files keep every listed marker; any src/ or bin/ file with an import.meta.main block must list it. */
export function entryProblems(ledger: Ledger, repo: Repo = diskRepo()): string[] {
  return Object.entries(ledger.files).flatMap(([f, e]) => {
    const text = repo.read(f) ?? "";
    const unlisted = /^(src|bin)\//.test(f) && text.includes("import.meta.main") && !e.entry?.includes("if (import.meta.main)");
    return [...(unlisted ? [`${f} has an import.meta.main block but no entry row`] : []), ...(e.entry ?? []).filter((m) => !text.includes(m)).map((m) => `${f} lost entry marker: ${m}`)];
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

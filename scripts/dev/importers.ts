#!/usr/bin/env bun
// Importer hygiene (P1.4b): no tracked file (git ls-files) reaches a moved name through its legacy path. A legacy module
// is one frozen in tests/compat/legacy-paths.manifest.generated.json; one of its exports is MOVED when the TypeScript
// checker resolves it to a declaration in another file, through aliases (`export { x } from`, `export *`, import-then-
// export, `export import x = ns.x`, `export default ns`) or a local declaration that only forwards (see forwardTarget).
// Every import form that reaches a moved name through the legacy module is a violation.
// Out of scope, by design: specifiers the checker cannot see statically (computed or string-built paths, eval, a
// `require` or `import()` whose argument is not a string literal). A mechanical move never writes these. A wrapper
// that adds behaviour (a default value, an extra or reordered argument, a class member) declares a name of its own.
//   bun scripts/dev/importers.ts     print current violations (exit 1 if any)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { importSpecifiers, LEDGER_PATH, readJson, ROOT, type Ledger } from "./boundaries.js";
import { MANIFEST_PATH } from "./snapshot-exports.js";

/** The whole exemption list. A file matching any entry may import through legacy paths. */
export const EXEMPT: Array<{ match: (file: string, ledger: Ledger) => boolean; reason: string }> = [
  { match: (f) => f.startsWith("tests/compat/"), reason: "the compatibility tests exist to exercise the frozen legacy paths" },
  { match: (f, l) => l.files[f]?.layer === "api", reason: "the api layer is the public re-export surface; nothing inside the repo imports it" },
];

const TS_FILE = /\.(c|m)?tsx?$/;
/** Every tracked TypeScript file except declaration files, repo-relative. */
export function trackedTs(root = ROOT): string[] {
  const out = spawnSync("git", ["ls-files", "--cached"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split("\n").filter((f) => TS_FILE.test(f) && !f.endsWith(".d.ts")).sort();
}

export function compilerOptions(root = ROOT): ts.CompilerOptions {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
  return { ...ts.parseJsonConfigFileContent(config, ts.sys, root).options, allowJs: true, noEmit: true };
}

/** A program over files on disk, or over in-memory files (absolute path -> text) layered on the real disk. */
export function makeProgram(files: string[], memory: Record<string, string> = {}, root = ROOT): ts.Program {
  const options = compilerOptions(root);
  const host = ts.createCompilerHost(options, true);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (f) => memory[f] ?? read(f);
  host.fileExists = (f) => f in memory || exists(f);
  const dirExists = host.directoryExists?.bind(host);
  host.directoryExists = (d) => Object.keys(memory).some((f) => f.startsWith(d + path.sep)) || (dirExists?.(d) ?? true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, ...rest) => (f in memory ? ts.createSourceFile(f, memory[f], lang, true) : getSourceFile(f, lang, ...rest));
  return ts.createProgram(files, options, host);
}

let shared: ts.Program | undefined;
/** One program over every tracked TypeScript file, built once per process and reused by every architecture test. */
export function repoProgram(): ts.Program {
  return (shared ??= makeProgram(trackedTs().map((f) => path.join(ROOT, f))));
}

export type Moved = Map<string, { homes: string[]; value: boolean }>; // export name -> files that declare it, and whether it has a runtime value
export type Analysis = { moved: Map<string, Moved>; violations: string[] };
/** Find moved names in `legacy` and every import of one of them from `scan`. Paths are relative to `root`. */
export function analyzeImporters(program: ts.Program, legacy: string[], scan: string[], root = ROOT): Analysis {
  const checker = program.getTypeChecker();
  const rel = (f: string) => path.relative(root, f);
  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) ? unwrap(e.expression) : e;
  const isEntity = (e: ts.Node): e is ts.Identifier | ts.PropertyAccessExpression => ts.isIdentifier(e) || (ts.isPropertyAccessExpression(e) && isEntity(e.expression));
  const symbolOf = (n: ts.Node) => checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : ts.isQualifiedName(n) ? n.right : n);
  const sameNames = (args: readonly ts.Node[] | undefined, params: readonly { name: ts.Node }[] | undefined) =>
    (args?.length ?? 0) === (params?.length ?? 0) && (args ?? []).every((a, i) => ts.isTypeReferenceNode(a) && ts.isIdentifier(a.typeName) && !a.typeArguments && a.typeName.text === (params![i].name as ts.Identifier).text);

  /** `function f(a, ...b) { return g(a, ...b); }` and its arrow forms: the callee, if arguments are exactly the parameters. */
  const wrapperCallee = (fn: ts.SignatureDeclaration & { body?: ts.Node }): ts.Symbol | undefined => {
    let expr: ts.Node | undefined = fn.body;
    if (expr && ts.isBlock(expr)) expr = expr.statements.length === 1 && ts.isReturnStatement(expr.statements[0]) ? expr.statements[0].expression : undefined;
    if (!expr || !ts.isExpression(expr)) return undefined;
    expr = unwrap(ts.isAwaitExpression(unwrap(expr)) ? (unwrap(expr) as ts.AwaitExpression).expression : expr);
    if (!ts.isCallExpression(expr) && !ts.isNewExpression(expr)) return undefined;
    const callee = unwrap(expr.expression);
    const args = expr.arguments ?? [];
    const ok = isEntity(callee) && args.length === fn.parameters.length && fn.parameters.every((p, i) => {
      const inner = p.dotDotDotToken ? (ts.isSpreadElement(args[i]) ? (args[i] as ts.SpreadElement).expression : undefined) : args[i];
      return ts.isIdentifier(p.name) && !p.initializer && !!inner && ts.isIdentifier(inner) && inner.text === p.name.text; // a default value is behaviour of its own
    });
    return ok ? symbolOf(callee) : undefined;
  };

  /** The one symbol a local declaration only forwards to, or undefined when it declares something of its own. */
  const forwardTarget = (d: ts.Declaration): ts.Symbol | undefined => {
    if (ts.isVariableDeclaration(d) && d.initializer) {
      const init = unwrap(d.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return wrapperCallee(init);
      if (isEntity(init)) return symbolOf(init);
      if (ts.isElementAccessExpression(init) && ts.isStringLiteralLike(init.argumentExpression)) return checker.getTypeAtLocation(init.expression).getProperty(init.argumentExpression.text);
      return undefined;
    }
    if (ts.isBindingElement(d) && !d.dotDotDotToken) { // const { f } = ns, const { f: g } = ns
      let root: ts.Node = d.parent;
      while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) root = root.parent;
      if (!ts.isVariableDeclaration(root) || !root.initializer || !ts.isObjectBindingPattern(d.parent) || d.parent.parent !== root) return undefined;
      const key = d.propertyName ?? d.name;
      return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? checker.getTypeAtLocation(unwrap(root.initializer)).getProperty(key.text) : undefined;
    }
    if (ts.isFunctionDeclaration(d) && d.body) return wrapperCallee(d);
    if (ts.isTypeAliasDeclaration(d)) {
      const t = d.type;
      if (ts.isTypeReferenceNode(t) && (!t.typeArguments || sameNames(t.typeArguments, d.typeParameters))) return symbolOf(t.typeName);
      if (ts.isImportTypeNode(t) && !t.isTypeOf && t.qualifier && (!t.typeArguments || sameNames(t.typeArguments, d.typeParameters))) return symbolOf(t.qualifier);
      return undefined;
    }
    if ((ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) && d.members.length === 0) {
      const h = d.heritageClauses;
      const base = h?.length === 1 && h[0].token === ts.SyntaxKind.ExtendsKeyword && h[0].types.length === 1 ? h[0].types[0] : undefined;
      if (base && isEntity(base.expression) && (!base.typeArguments || sameNames(base.typeArguments, d.typeParameters))) return symbolOf(base.expression);
    }
    return undefined;
  };

  /** Files that finally declare a symbol, following aliases and forwarding declarations. */
  const homes = (start: ts.Symbol): string[] => {
    const out = new Set<string>();
    const seen = new Set<ts.Symbol>();
    const walk = (s: ts.Symbol | undefined): void => {
      if (!s || seen.has(s)) return;
      seen.add(s);
      if (s.flags & ts.SymbolFlags.Alias) return walk(checker.getAliasedSymbol(s));
      for (const d of s.declarations ?? []) {
        if (ts.isSourceFile(d)) { out.add(d.fileName); continue; } // a namespace re-export lands on the whole module
        const next = forwardTarget(d);
        if (next && !seen.has(next)) walk(next);
        else out.add(d.getSourceFile().fileName);
      }
    };
    walk(start);
    return [...out];
  };

  const exportsOf = (abs: string) => {
    const mod = program.getSourceFile(abs) && checker.getSymbolAtLocation(program.getSourceFile(abs)!);
    return mod ? checker.getExportsOfModule(mod) : [];
  };
  const moved = new Map<string, Moved>();
  for (const file of legacy) {
    const abs = path.join(root, file);
    const names: Moved = new Map();
    for (const s of exportsOf(abs)) {
      const elsewhere = homes(s).filter((h) => h !== abs);
      const value = !!((s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s).flags & ts.SymbolFlags.Value);
      if (elsewhere.length) names.set(s.name, { homes: elsewhere.map(rel).sort(), value });
    }
    moved.set(file, names);
  }

  const host: ts.ModuleResolutionHost = { fileExists: (f) => !!program.getSourceFile(f) || ts.sys.fileExists(f), readFile: (f) => program.getSourceFile(f)?.text ?? ts.sys.readFile(f) };
  const target = (spec: string, from: string) => {
    const r = ts.resolveModuleName(spec, from, program.getCompilerOptions(), host).resolvedModule;
    return r && !r.isExternalLibraryImport ? rel(r.resolvedFileName) : undefined;
  };

  const violations: string[] = [];
  // every exported name; what a module object used as a value reaches (never a type-only export); what `export * from` forwards
  const [ALL, ALL_VALUES, ALL_BUT_DEFAULT] = ["*", "*values", "*-default"];
  for (const file of scan) {
    const sf = program.getSourceFile(path.join(root, file));
    if (!sf) throw new Error(`not in program: ${file}`);
    const key = (e: ts.Node | undefined) => (e && (ts.isIdentifier(e) || ts.isStringLiteralLike(e)) ? e.text : ALL_VALUES);
    /** Names a module object at `n` reaches: `.x`, `["x"]`, `ns.T`, `const { x } =`; `const m =` and `.then((m) =>` follow m; else every value. */
    const uses = (n: ts.Node): string[] => {
      while (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent)) n = n.parent;
      const p = n.parent;
      if (ts.isPropertyAccessExpression(p) && p.expression === n) {
        if (p.name.text !== "then" || !ts.isCallExpression(p.parent)) return [p.name.text];
        const cb = p.parent.arguments[0];
        return follow(cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? cb.parameters[0]?.name : undefined);
      }
      if (ts.isQualifiedName(p) && p.left === n) return [p.right.text];
      if (ts.isElementAccessExpression(p) && p.expression === n) return [key(p.argumentExpression)];
      const exported = ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Export; // the object escapes
      return ts.isVariableDeclaration(p) && p.initializer === n && !exported ? follow(p.name) : [ALL_VALUES];
    };
    const follow = (b: ts.BindingName | undefined): string[] =>
      b && ts.isIdentifier(b) ? bindingUses(b) : b && ts.isObjectBindingPattern(b) ? b.elements.map((e) => (e.dotDotDotToken ? ALL_VALUES : key(e.propertyName ?? e.name))) : [ALL_VALUES];
    const bindingUses = (name: ts.Identifier): string[] => {
      const sym = checker.getSymbolAtLocation(name);
      const found: string[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && n !== name && n.text === name.text) {
          const p = n.parent;
          const s = ts.isExportSpecifier(p) ? checker.getExportSpecifierLocalTargetSymbol(p) : ts.isShorthandPropertyAssignment(p) ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(n);
          if (s === sym && !(ts.isPropertyAccessExpression(p) && p.name === n) && !(ts.isQualifiedName(p) && p.right === n)) found.push(...uses(n));
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return found;
    };
    const report = (node: ts.Node, spec: string, names: string[], shimOnly = false) => {
      const to = target(spec, sf.fileName);
      const m = to && moved.get(to);
      if (!m || m.size === 0) return;
      // a side-effect import reaches nothing by name; it matters only when the module is nothing but a shim
      if (shimOnly && exportsOf(path.join(root, to)).some((s) => !m.has(s.name))) return;
      const hit = [...new Set(names.flatMap((n) => (n === ALL ? [...m.keys()] : n === ALL_VALUES ? [...m].filter(([, v]) => v.value).map(([k]) => k) : n === ALL_BUT_DEFAULT ? [...m.keys()].filter((k) => k !== "default") : m.has(n) ? [n] : [])))].sort();
      if (hit.length === 0) return;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      violations.push(`${file}:${line} reaches ${hit.join(", ")} through legacy ${to} (declared in ${[...new Set(hit.flatMap((h) => m.get(h)!.homes))].sort().join(", ")})`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const c = node.importClause;
        const b = c?.namedBindings;
        const names = [...(c?.name ? ["default"] : []), ...(b && ts.isNamedImports(b) ? b.elements.map((e) => (e.propertyName ?? e.name).text) : b ? bindingUses(b.name) : [])];
        report(node, node.moduleSpecifier.text, c ? names : [ALL], !c);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const c = node.exportClause;
        // `export * from` forwards every name but default; `export * as ns from` forwards all of them
        report(node, node.moduleSpecifier.text, c && ts.isNamedExports(c) ? c.elements.map((e) => (e.propertyName ?? e.name).text) : c ? [ALL] : [ALL_BUT_DEFAULT]);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
        report(node, node.moduleReference.expression.text, bindingUses(node.name));
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        report(node, node.arguments[0].text, uses(node));
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        let first: ts.EntityName | undefined = node.qualifier;
        while (first && ts.isQualifiedName(first)) first = first.left;
        const p = node.parent;
        const indexed = !first && ts.isIndexedAccessTypeNode(p) && p.objectType === node && ts.isLiteralTypeNode(p.indexType) && ts.isStringLiteral(p.indexType.literal) ? p.indexType.literal.text : undefined;
        report(node, node.argument.literal.text, [first ? first.text : indexed ?? (node.isTypeOf ? ALL_VALUES : ALL)]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { moved, violations: violations.sort() };
}

/** The rule on the repo as checked in: every tracked TypeScript file, minus the exemptions, against the frozen modules. */
export function repoAnalysis(): Analysis {
  const ledger = readJson<Ledger>(LEDGER_PATH);
  const legacy = Object.keys(readJson<Record<string, unknown>>(MANIFEST_PATH));
  const scan = trackedTs().filter((f) => !EXEMPT.some((e) => e.match(f, ledger)));
  return analyzeImporters(repoProgram(), legacy, scan);
}

/** Every repo file reachable from `start` through literal imports of any form, resolved by the compiler, `start` included. */
export function importClosure(start: string): string[] {
  const seen = new Set([start]);
  for (const f of seen) {
    const abs = path.join(ROOT, f);
    for (const spec of importSpecifiers(readFileSync(abs, "utf8"), abs)) {
      const r = ts.resolveModuleName(spec, abs, compilerOptions(), ts.sys).resolvedModule;
      if (r && !r.isExternalLibraryImport) seen.add(path.relative(ROOT, r.resolvedFileName));
    }
  }
  return [...seen].sort();
}

if (import.meta.main) {
  const { violations } = repoAnalysis();
  console.log(violations.length ? violations.join("\n") : "no importer violations");
  process.exit(violations.length ? 1 : 0);
}

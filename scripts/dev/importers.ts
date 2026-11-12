#!/usr/bin/env bun
// Importer hygiene (P1.4b): no tracked source file (git ls-files: .ts .tsx .mts .cts .js .jsx .mjs .cjs, .d.ts included)
// reaches a MOVED name through its legacy path. A legacy module is one frozen in
// tests/compat/legacy-paths.manifest.generated.json. One of its exports is moved only when (lead ruling R1, PR #59):
//   - the checker resolves it through re-export aliases (`export { x } from`, `export *`, `export { y as x }`,
//     `export default` or `export =` of an imported binding, `export import`) to a declaration in another file; or
//   - it is `const X = E` (or let/var) where E, parentheses stripped, is exactly an identifier or a property-access chain
//     whose root is a binding imported from another file; or
//   - it is `type X = T` with no type parameters, T exactly a type reference without type arguments (or `import("…").T`)
//     to a type from another file; or an empty-bodied, non-generic `interface X extends T {}` / `class X extends T {}`.
// LIMIT: everything else a legacy module declares (every function or arrow whatever its body, every class with a member,
// every generic alias, every async or generator function) is that module's own declaration, and importing it through
// the legacy path is not a violation. Consequence: when a legacy path is deleted, the compiler names any importer still
// using a hand-written wrapper.
// The rule fails closed (R3): a frozen module it cannot read, or a relative/absolute literal specifier that resolves to
// no file, is an error, never a clean result. Files are compared by real path (R4). Out of scope: specifiers that are
// not literals (computed, string-built, held in a variable, eval) and JSDoc types in .ts files (TypeScript ignores them).
//   bun scripts/dev/importers.ts     print current violations and errors (exit 1 if any)
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { importSpecifiers, LEDGER_PATH, readJson, ROOT, type Ledger } from "./boundaries.js";
import { MANIFEST_PATH } from "./snapshot-exports.js";

/** The whole exemption list. A file matching any entry may import through legacy paths. */
export const EXEMPT: Array<{ match: (file: string, ledger: Ledger) => boolean; reason: string }> = [
  { match: (f) => f.startsWith("tests/compat/"), reason: "the compatibility tests exist to exercise the frozen legacy paths" },
  { match: (f, l) => l.files[f]?.layer === "api", reason: "the api layer is the public re-export surface; nothing inside the repo imports it" },
];

export const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/; // declaration files included
const JS_FILE = /\.(js|jsx|mjs|cjs)$/;
/** Every tracked source file, repo-relative (R2: no other filter). */
export function trackedSources(root = ROOT): string[] {
  const out = spawnSync("git", ["ls-files", "--cached"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split("\n").filter((f) => SOURCE_FILE.test(f)).sort();
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
/** One program over every tracked source file, built once per process. */
export function repoProgram(): ts.Program {
  return (shared ??= makeProgram(trackedSources().map((f) => path.join(ROOT, f))));
}

/** Real path (letter case as on disk, symlinks followed), or the path itself for a file that exists only in memory. */
const canonical = (f: string) => {
  try {
    return realpathSync.native(f);
  } catch {
    return f;
  }
};
const isRelative = (spec: string) => spec.startsWith(".") || spec.startsWith("/");

export type Moved = Map<string, { homes: string[]; value: boolean }>; // export name -> files that declare it, and whether it has a runtime value
export type Analysis = { moved: Map<string, Moved>; violations: string[]; errors: string[] };

/** Find moved names in `legacy` and every import of one of them from `scan`. Paths are relative to `root`. */
export function analyzeImporters(program: ts.Program, legacy: string[], scan: string[], root = ROOT): Analysis {
  const checker = program.getTypeChecker();
  const rel = (f: string) => path.relative(root, f);
  const errors: string[] = [];
  const isEntity = (e: ts.Node): e is ts.Identifier | ts.PropertyAccessExpression => ts.isIdentifier(e) || (ts.isPropertyAccessExpression(e) && isEntity(e.expression));
  const rootOf = (e: ts.Node): ts.Node => (ts.isPropertyAccessExpression(e) ? rootOf(e.expression) : ts.isQualifiedName(e) ? rootOf(e.left) : e);
  const symbolOf = (n: ts.Node) => checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : ts.isQualifiedName(n) ? n.right : n);
  /** True when the root identifier of an entity name is a binding imported from another file. */
  const importedRoot = (e: ts.Node) => {
    const d = checker.getSymbolAtLocation(rootOf(e))?.declarations?.[0];
    return !!d && (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d) || ts.isImportEqualsDeclaration(d));
  };
  const onlyExportModifiers = (d: ts.HasModifiers) => (ts.getModifiers(d) ?? []).every((m) => [ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DefaultKeyword, ts.SyntaxKind.DeclareKeyword].includes(m.kind));

  /** R1: the one symbol a local declaration exactly forwards to, or undefined when it is the module's own declaration. */
  const forwardTarget = (d: ts.Declaration): ts.Symbol | undefined => {
    if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer) {
      let init: ts.Expression = d.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      return isEntity(init) && importedRoot(init) ? symbolOf(init) : undefined;
    }
    if (ts.isTypeAliasDeclaration(d) && !d.typeParameters) {
      const t = d.type;
      if (ts.isTypeReferenceNode(t) && !t.typeArguments && importedRoot(t.typeName)) return symbolOf(t.typeName);
      if (ts.isImportTypeNode(t) && !t.isTypeOf && t.qualifier && !t.typeArguments) return symbolOf(t.qualifier);
      return undefined;
    }
    if ((ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) && d.members.length === 0 && !d.typeParameters && onlyExportModifiers(d)) {
      const h = d.heritageClauses;
      const base = h?.length === 1 && h[0].token === ts.SyntaxKind.ExtendsKeyword && h[0].types.length === 1 ? h[0].types[0] : undefined;
      if (base && !base.typeArguments && isEntity(base.expression) && importedRoot(base.expression)) return symbolOf(base.expression);
    }
    return undefined;
  };

  /** Files that finally declare a symbol, following re-export aliases and R1 forwarding declarations. */
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
    return [...out].map(canonical);
  };

  const exportsOf = (abs: string) => {
    const sf = program.getSourceFile(abs);
    const mod = sf && checker.getSymbolAtLocation(sf);
    return { sf, symbols: mod ? checker.getExportsOfModule(mod) : undefined };
  };
  const moved = new Map<string, Moved>(); // canonical path -> moved names
  const legacyName = new Map<string, string>(); // canonical path -> manifest key
  for (const file of legacy) {
    const abs = path.join(root, file);
    const { sf, symbols } = exportsOf(abs);
    if (!sf || !symbols) { // R3: never "no moved names" for a module the rule could not read
      errors.push(`cannot analyse legacy module ${file}: ${sf ? "it has no module symbol (no import or export)" : "it is not in the program"}`);
      continue;
    }
    const self = canonical(abs);
    const names: Moved = new Map();
    for (const s of symbols) {
      const elsewhere = homes(s).filter((h) => h !== self);
      const value = !!((s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s).flags & ts.SymbolFlags.Value);
      if (elsewhere.length) names.set(s.name, { homes: elsewhere.map(rel).sort(), value });
    }
    moved.set(self, names);
    legacyName.set(self, file);
  }

  const host: ts.ModuleResolutionHost = { fileExists: (f) => !!program.getSourceFile(f) || ts.sys.fileExists(f), readFile: (f) => program.getSourceFile(f)?.text ?? ts.sys.readFile(f) };
  const resolve = (spec: string, from: string) => ts.resolveModuleName(spec, from, program.getCompilerOptions(), host).resolvedModule;

  const violations: string[] = [];
  // every exported name; what a module object used as a value reaches (never a type-only export); what `export * from` forwards
  const [ALL, ALL_VALUES, ALL_BUT_DEFAULT] = ["*", "*values", "*-default"];
  for (const file of scan) {
    const sf = program.getSourceFile(path.join(root, file));
    if (!sf) {
      errors.push(`cannot analyse ${file}: it is not in the program`);
      continue;
    }
    const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
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
    /** The legacy module a literal specifier reaches, by real path; R3 and R4 checks on the way. */
    const reach = (node: ts.Node, spec: string, strict = true): { to: string; m: Moved } | undefined => {
      const r = resolve(spec, sf.fileName);
      if (!r) {
        if (strict && isRelative(spec)) errors.push(`cannot analyse ${file}:${lineOf(node)}: "${spec}" does not resolve to a file`);
        return undefined;
      }
      if (r.isExternalLibraryImport) return undefined; // a package, skipped because of what it is
      const real = canonical(r.resolvedFileName);
      if (strict && real !== r.resolvedFileName && real.toLowerCase() === r.resolvedFileName.toLowerCase())
        violations.push(`${file}:${lineOf(node)} "${spec}" differs in letter case from the tracked path ${rel(real)} (breaks on a case-sensitive file system)`);
      const m = moved.get(real);
      return m && m.size ? { to: legacyName.get(real)!, m } : undefined;
    };
    const expand = (m: Moved, names: string[]) => [...new Set(names.flatMap((n) => (n === ALL ? [...m.keys()] : n === ALL_VALUES ? [...m].filter(([, v]) => v.value).map(([k]) => k) : n === ALL_BUT_DEFAULT ? [...m.keys()].filter((k) => k !== "default") : m.has(n) ? [n] : [])))].sort();
    const report = (node: ts.Node, spec: string, names: string[], shimOnly = false) => {
      const hit = reach(node, spec);
      if (!hit) return;
      // a side-effect import reaches nothing by name; it matters only when the module is nothing but a shim
      if (shimOnly && (exportsOf(path.join(root, hit.to)).symbols ?? []).some((s) => !hit.m.has(s.name))) return;
      const names2 = expand(hit.m, names);
      if (names2.length) violations.push(`${file}:${lineOf(node)} reaches ${names2.join(", ")} through legacy ${hit.to} (declared in ${[...new Set(names2.flatMap((h) => hit.m.get(h)!.homes))].sort().join(", ")})`);
    };
    const strip = (e: ts.Expression): ts.Expression =>
      ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) ? strip(e.expression) : e;
    const isRequire = (e: ts.Expression) => ts.isIdentifier(strip(e)) && (strip(e) as ts.Identifier).text === "require";
    const isCreateRequire = (e: ts.Expression): boolean => {
      const c = strip(e);
      if (ts.isCallExpression(c)) { const f = strip(c.expression); return (ts.isIdentifier(f) && f.text === "createRequire") || (ts.isPropertyAccessExpression(f) && f.name.text === "createRequire"); }
      const d = ts.isIdentifier(c) ? checker.getSymbolAtLocation(c)?.valueDeclaration : undefined; // a local bound from createRequire(…)
      return !!d && ts.isVariableDeclaration(d) && !!d.initializer && d.initializer !== e && isCreateRequire(d.initializer);
    };
    /** R5: the literal specifier of a recognised loader call, or undefined. */
    const loaderSpec = (call: ts.CallExpression): ts.Expression | undefined => {
      const callee = strip(call.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword || isRequire(callee) || isCreateRequire(callee)) return call.arguments[0];
      if (ts.isPropertyAccessExpression(callee) && isRequire(callee.expression)) {
        if (callee.name.text === "call") return call.arguments[1];
        const list = call.arguments[1] && strip(call.arguments[1]);
        if (callee.name.text === "apply" && list && ts.isArrayLiteralExpression(list)) return list.elements[0];
      }
      return undefined;
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
      } else if (ts.isCallExpression(node) && loaderSpec(node)) {
        const spec = loaderSpec(node)!;
        if (ts.isStringLiteralLike(spec)) report(node, spec.text, uses(node)); // a non-literal specifier is out of scope
      } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0]) && isRelative(node.arguments[0].text)) {
        const hit = reach(node, node.arguments[0].text, false); // R5 backstop: an unknown form must not be silent
        if (hit) violations.push(`${file}:${lineOf(node)} unrecognised loader reaches legacy ${hit.to} (moved there: ${[...hit.m.keys()].sort().join(", ")})`);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        let first: ts.EntityName | undefined = node.qualifier;
        while (first && ts.isQualifiedName(first)) first = first.left;
        const p = node.parent;
        const indexed = !first && ts.isIndexedAccessTypeNode(p) && p.objectType === node && ts.isLiteralTypeNode(p.indexType) && ts.isStringLiteral(p.indexType.literal) ? p.indexType.literal.text : undefined;
        report(node, node.argument.literal.text, [first ? first.text : indexed ?? (node.isTypeOf ? ALL_VALUES : ALL)]);
      }
      if (JS_FILE.test(file)) for (const doc of (node as { jsDoc?: ts.JSDoc[] }).jsDoc ?? []) visit(doc); // JSDoc types are real in JavaScript
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { moved, violations: violations.sort(), errors: errors.sort() };
}

/** The rule on the repo as checked in: every tracked source file, minus the exemptions, against the frozen modules. */
export function repoAnalysis(): Analysis {
  const ledger = readJson<Ledger>(LEDGER_PATH);
  const legacy = Object.keys(readJson<Record<string, unknown>>(MANIFEST_PATH));
  const tracked = trackedSources();
  const scan = tracked.filter((f) => !EXEMPT.some((e) => e.match(f, ledger)));
  const result = analyzeImporters(repoProgram(), legacy, scan);
  const untracked = legacy.filter((f) => !tracked.includes(f)).map((f) => `cannot analyse legacy module ${f}: it is not a tracked file`);
  return { ...result, errors: [...untracked, ...result.errors].sort() };
}

/** Every repo file reachable from `start` through literal imports of any form, `start` included. A relative or absolute
 * specifier that resolves to no file throws (R3); packages and built-ins are left out because of what they are. */
export function importClosure(start: string, root = ROOT): string[] {
  const seen = new Set([start]);
  for (const f of seen) {
    const abs = path.join(root, f);
    for (const spec of importSpecifiers(readFileSync(abs, "utf8"), abs)) {
      const r = ts.resolveModuleName(spec, abs, compilerOptions(), ts.sys).resolvedModule;
      if (!r && isRelative(spec)) throw new Error(`cannot analyse ${f}: "${spec}" does not resolve to a file`);
      if (r && !r.isExternalLibraryImport) seen.add(path.relative(root, r.resolvedFileName));
    }
  }
  return [...seen].sort();
}

if (import.meta.main) {
  const { violations, errors } = repoAnalysis();
  console.log([...errors, ...violations].join("\n") || "no importer violations");
  process.exit(errors.length || violations.length ? 1 : 0);
}

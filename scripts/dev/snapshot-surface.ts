#!/usr/bin/env bun
// Public surface freeze. The package's "." export is src/api/index.ts. tests/api/surface.snapshot.generated.json holds:
//   sha256  over the compiler's own declaration output (tsc --declaration --emitDeclarationOnly, in memory) for the front door
//           and every repo .d.ts its declarations reach, files in sorted order, paths repo-relative, LF line endings. It decides.
//   files   the sha256 of each of those .d.ts files, and names: each public name's kind and the text of its emitted declaration.
//           Both only label a failure; neither can make the test pass.
// A public declaration may name only public repo types, TypeScript's library types and the runtime's ambient types (Bun, Node).
//   bun scripts/dev/snapshot-surface.ts            print the current surface and what it names from outside the repo
//   bun scripts/dev/snapshot-surface.ts --update   rewrite the snapshot (a deliberate public change; give the reason in the PR)
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { importSpecifiers, ROOT } from "./boundaries.js";
import { meanings, type Meaning } from "./snapshot-exports.js";

export const API_ENTRY = "src/api/index.ts";
export const SURFACE_PATH = path.join(ROOT, "tests/api/surface.snapshot.generated.json");
export type Surface = { sha256: string; files: Record<string, string>; names: Record<string, { kind: Meaning; declaration: string }> };
export type SurfaceReport = { surface: Surface; unexported: string[]; thirdParty: string[]; ambient: Record<string, string[]> };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const LIB = /\/node_modules\/typescript\/lib\//;
const AMBIENT = /\/node_modules\/(@types\/bun|bun-types|@types\/node)\//; // the runtime's own types: Bun and node: built-ins

function repoPath(file: string, root: string): string | undefined {
  const rel = path.relative(root, file);
  return rel && !path.isAbsolute(rel) && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !rel.split(path.sep).includes("node_modules") ? rel : undefined;
}

const declarationPath = (file: string) => file.replace(/(?<!\.d)\.(mts|cts|ts)$/, ".d.$1");

function compilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
  return ts.parseJsonConfigFileContent(config, ts.sys, ROOT).options;
}

/** Emitted declarations and repo-authored declaration inputs, in memory, keyed by repo-relative path, LF line endings. */
export function emitDeclarations(entry = API_ENTRY, root = ROOT): Map<string, string> {
  const options = { ...compilerOptions(), noEmit: false, declaration: true, emitDeclarationOnly: true, declarationMap: false, sourceMap: false };
  const program = ts.createProgram([path.join(root, entry)], options);
  const out = new Map<string, string>();
  const result = program.emit(undefined, (file, text) => out.set(path.relative(root, file), text.replace(/\r\n/g, "\n")), undefined, true);
  if (result.emitSkipped || result.diagnostics.length > 0) throw new Error(`declaration emit failed:\n${result.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n")}`);
  // Declaration inputs are read, but never emitted, by TypeScript. Keep their original text too.
  for (const source of program.getSourceFiles()) {
    const rel = repoPath(source.fileName, root);
    if (source.isDeclarationFile && rel) out.set(rel, source.text.replace(/\r\n/g, "\n"));
  }
  return out;
}

/** The entry's .d.ts and every repo .d.ts reachable from it through relative specifiers, sorted. */
export function declarationClosure(decls: Map<string, string>, entry = API_ENTRY, root = ROOT): string[] {
  const start = declarationPath(entry);
  const options = compilerOptions();
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => decls.has(path.relative(root, file)),
    readFile: (file) => decls.get(path.relative(root, file)),
  };
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    if (!decls.has(file)) throw new Error(`cannot emit or read reached declaration file ${file}`);
    seen.add(file);
    for (const spec of importSpecifiers(decls.get(file) ?? "", file)) {
      if (!spec.startsWith(".")) continue; // packages and builtins: judged by the third-party rule, not hashed
      const resolved = ts.resolveModuleName(spec, path.join(root, file), options, host).resolvedModule;
      if (!resolved) throw new Error(`cannot emit or read reached repo file ${path.join(path.dirname(file), spec)} (referenced by ${file})`);
      visit(path.relative(root, resolved.resolvedFileName));
    }
  };
  visit(start);
  if (!seen.has(start)) throw new Error(`no declaration emitted for ${entry}`);
  return [...seen].sort();
}

/** The surface of an entry file (repo-relative), read from its emitted declarations under the repo's tsconfig. */
export function readSurface(entry = API_ENTRY, root = ROOT): SurfaceReport {
  const decls = emitDeclarations(entry, root);
  const closure = declarationClosure(decls, entry, root);
  const files = Object.fromEntries(closure.map((f) => [f, sha(decls.get(f) ?? "")]));
  const digest = sha(closure.map((f) => `--- ${f}\n${decls.get(f)}`).join("\n"));
  if (closure.some((f) => decls.get(f)?.includes(root))) throw new Error("emitted declarations contain an absolute path");

  // A second program over the emitted .d.ts alone (repo .ts sources hidden), so every public type is spelled out in syntax.
  const options = { ...compilerOptions(), noEmit: true };
  const host = ts.createCompilerHost(options);
  const repoFile = (f: string) => repoPath(f, root);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => (repoFile(f) ? decls.has(repoFile(f)!) : fileExists.call(host, f));
  host.readFile = (f) => (repoFile(f) ? decls.get(repoFile(f)!) : readFile.call(host, f));
  host.getSourceFile = (f, lang, ...rest) => {
    const rel = repoFile(f);
    if (!rel) return getSourceFile.call(host, f, lang, ...rest);
    const text = decls.get(rel);
    return text === undefined ? undefined : ts.createSourceFile(f, text, lang, true);
  };
  const entryDts = path.join(root, declarationPath(entry));
  const program = ts.createProgram([entryDts], options, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(entryDts);
  const moduleSymbol = sf && checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) throw new Error(`cannot read the declarations of ${entry}`);
  const resolve = (s: ts.Symbol) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  const exports = [...checker.getExportsOfModule(moduleSymbol)].sort((a, b) => a.name.localeCompare(b.name));
  const publicTargets = new Set(exports.map(resolve));
  const statementOf = (n: ts.Node): ts.Node => (n.parent && !ts.isSourceFile(n.parent) ? statementOf(n.parent) : n);

  const names: Surface["names"] = {};
  const unexported = new Set<string>();
  const thirdParty = new Set<string>();
  const ambient: Record<string, Set<string>> = {};
  for (const s of exports) {
    const target = resolve(s);
    const spec = s.declarations?.find(ts.isExportSpecifier);
    const typeOnly = !!spec && (spec.isTypeOnly || spec.parent.parent.isTypeOnly); // the export's own meaning, not its target's
    const isType = !!(target.flags & ts.SymbolFlags.Type);
    const runtime = !typeOnly && !!(target.flags & ts.SymbolFlags.Value);
    const statements = [...new Set((target.declarations ?? []).map(statementOf))];
    const declaration = statements.map((st) => `// ${path.relative(root, st.getSourceFile().fileName)}\n${st.getText()}`).join("\n");
    names[s.name] = { kind: meanings({ [s.name]: isType }, runtime ? { [s.name]: true } : {})[s.name], declaration };

    // Re-exported targets have an origin of their own, even when their bodies mention no named types.
    const classifyOrigin = (sym: ts.Symbol, file: string) => {
      if (repoFile(file)) return;
      if (LIB.test(file)) (ambient[s.name] ??= new Set()).add(`${sym.name} (typescript lib)`);
      else if (AMBIENT.test(file)) (ambient[s.name] ??= new Set()).add(`${sym.name} (${AMBIENT.exec(file)?.[1]})`);
      else thirdParty.add(`${s.name} names ${sym.name} from ${/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1] ?? path.relative(root, file)}`);
    };
    for (const declaration of target.declarations ?? []) classifyOrigin(target, declaration.getSourceFile().fileName);

    // Every type a public declaration names must be public, from TypeScript's library, or the runtime's ambient types.
    const check = (nameNode: ts.Node, typeNode: ts.TypeNode | undefined) => {
      let sym = checker.getSymbolAtLocation(nameNode);
      if (!sym && typeNode) sym = checker.getTypeFromTypeNode(typeNode).aliasSymbol ?? checker.getTypeFromTypeNode(typeNode).symbol;
      if (!sym) return;
      sym = resolve(sym);
      if (sym.flags & ts.SymbolFlags.TypeParameter) return;
      const file = sym.declarations?.[0]?.getSourceFile().fileName;
      if (!file) return;
      if (repoFile(file)) {
        if (!publicTargets.has(sym)) unexported.add(`${sym.name} (named by ${s.name})`);
      } else classifyOrigin(sym, file);
    };
    const visit = (n: ts.Node): void => {
      if (ts.isTypeReferenceNode(n)) check(n.typeName, n);
      else if (ts.isExpressionWithTypeArguments(n)) check(n.expression, undefined);
      else if (ts.isTypeQueryNode(n)) check(n.exprName, n);
      else if (ts.isImportTypeNode(n)) check(n.qualifier ?? n, n);
      ts.forEachChild(n, visit);
    };
    statements.forEach(visit);
  }
  return {
    surface: { sha256: digest, files, names },
    unexported: [...unexported].sort(),
    thirdParty: [...thirdParty].sort(),
    ambient: Object.fromEntries(Object.entries(ambient).map(([n, set]) => [n, [...set].sort()])),
  };
}

/** Labels for a failure: added, removed or changed public names, then .d.ts files that changed. The hash comparison decides. */
export function surfaceDiff(frozen: Surface, current: Surface): string[] {
  const out: string[] = [];
  for (const [n, e] of Object.entries(current.names)) {
    const was = frozen.names[n];
    if (!was) out.push(`added public name ${n} (${e.kind}):\n${e.declaration}`);
    else if (was.kind !== e.kind) out.push(`${n} changed kind: ${was.kind} -> ${e.kind}`);
    else if (was.declaration !== e.declaration) out.push(`${n} changed declaration:\n  was: ${was.declaration.replace(/\n/g, "\n       ")}\n  now: ${e.declaration.replace(/\n/g, "\n       ")}`);
  }
  for (const n of Object.keys(frozen.names)) if (!current.names[n]) out.push(`removed public name ${n}`);
  const publicNameChanged = out.length > 0;
  for (const f of [...new Set([...Object.keys(frozen.files), ...Object.keys(current.files)])].sort()) {
    if (frozen.files[f] !== current.files[f]) out.push(publicNameChanged
      ? `declarations changed in ${f}${current.files[f] ? (frozen.files[f] ? "" : " (newly reached)") : " (no longer reached)"}`
      : `no public name changed; the declaration file ${f} that the surface reaches changed; if that is intended, regenerate with \`bun scripts/dev/snapshot-surface.ts --update\``);
  }
  if (frozen.sha256 !== current.sha256 && out.length === 0) out.push(`declaration closure sha256 differs: ${frozen.sha256} -> ${current.sha256}`);
  return out;
}

if (import.meta.main) {
  const report = readSurface();
  const problems = [...report.unexported.map((u) => `not public: ${u}`), ...report.thirdParty];
  if (problems.length > 0) {
    console.error(`public declarations name types outside the allowed set:\n${problems.join("\n")}`);
    process.exit(1);
  }
  if (process.argv[2] === "--update") {
    writeFileSync(SURFACE_PATH, `${JSON.stringify(report.surface, null, 2)}\n`);
    console.log(`wrote ${Object.keys(report.surface.names).length} public names over ${Object.keys(report.surface.files).length} declaration files to ${path.relative(ROOT, SURFACE_PATH)}`);
  } else console.log(JSON.stringify(report, null, 2));
}

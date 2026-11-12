#!/usr/bin/env bun
// Public surface freeze. The package's "." export is src/api/index.ts; tests/api/surface.snapshot.generated.json records each
// exported name, its kind (value, type or both) and its signature as the TypeScript checker prints it, plus a sha256 over all of them.
// A type is printed member by member, so a change inside a public type changes its own line; every named repo type that a public
// signature reaches must itself be exported, so no public signature can change behind a name the snapshot does not expand.
//   bun scripts/dev/snapshot-surface.ts            print the current surface
//   bun scripts/dev/snapshot-surface.ts --update   rewrite the snapshot (a deliberate public change; give the reason in the PR)
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ROOT } from "./boundaries.js";
import { meanings, type Meaning } from "./snapshot-exports.js";

export const API_ENTRY = "src/api/index.ts";
export const SURFACE_PATH = path.join(ROOT, "tests/api/surface.snapshot.generated.json");
export type Surface = { sha256: string; names: Record<string, { kind: Meaning; signature: string }> };

const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrayAsGenericType | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

/** The surface of an entry file (repo-relative), read by the checker under the repo's tsconfig. */
export function readSurface(entry = API_ENTRY, root = ROOT): { surface: Surface; unexported: string[] } {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  const program = ts.createProgram([path.join(root, entry)], options);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(path.join(root, entry));
  const moduleSymbol = sf && checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) throw new Error(`cannot read ${entry}`);
  const resolve = (s: ts.Symbol) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  const exports = checker.getExportsOfModule(moduleSymbol);
  const publicTypes = new Set(exports.map(resolve).filter((s) => s.flags & ts.SymbolFlags.Type));
  const inRepo = (s: ts.Symbol | undefined) => (s?.declarations ?? []).some((d) => /^(src|bin)\//.test(path.relative(root, d.getSourceFile().fileName)));
  const reached = new Map<ts.Symbol, string>(); // named repo types a public signature names, and the first public name that named it

  // A canonical print: named repo types by name (each public one is expanded in its own entry), unions, intersections and members
  // sorted, so the text depends on the declared shapes alone, not on the checker's internal type order.
  const print = (t: ts.Type, from: string, top = false): string => {
    const named = t.aliasSymbol ?? (t.symbol && t.symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum) ? t.symbol : undefined);
    const args = (list: readonly ts.Type[] | undefined) => (list?.length ? `<${list.map((a) => print(a, from)).join(", ")}>` : "");
    const refArgs = (r: ts.Type) => ((r as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(r as ts.TypeReference).slice(0, (r as ts.TypeReference).target.typeParameters?.length ?? 0) : undefined); // not the implicit `this`
    if (named && inRepo(named) && !top) {
      if (!reached.has(named)) reached.set(named, from);
      return named.name + args(t.aliasSymbol ? t.aliasTypeArguments : refArgs(t));
    }
    if (t.aliasSymbol && !inRepo(t.aliasSymbol)) return t.aliasSymbol.name + args(t.aliasTypeArguments); // Record<K, V>, Partial<T>…
    if (t.isUnion() || t.isIntersection()) {
      const parts = new Set(t.types.map((m) => print(m, from)).map((m) => (/^(new )?\(/.test(m) ? `(${m})` : m))); // a function inside a union is parenthesized
      if (parts.has("false") && parts.has("true")) {
        parts.delete("false");
        parts.delete("true");
        parts.add("boolean");
      }
      return [...parts].sort().join(t.isUnion() ? " | " : " & ");
    }
    if (!(t.flags & ts.TypeFlags.Object)) return checker.typeToString(t, undefined, FLAGS); // primitives and literals
    if ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference && !inRepo(t.symbol)) return t.symbol.name + args(refArgs(t)); // Array<T>, Promise<T>
    if (t.symbol && !inRepo(t.symbol) && !(t.symbol.flags & ts.SymbolFlags.TypeLiteral)) return checker.typeToString(t, undefined, FLAGS); // RegExp, Date…
    const param = (p: ts.Symbol) => {
      const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
      const optional = decl && ts.isParameter(decl) && checker.isOptionalParameter(decl) ? "?" : "";
      return `${decl?.dotDotDotToken ? "..." : ""}${p.name}${optional}: ${print(checker.getTypeOfSymbol(p), from)}`;
    };
    const signatures = (kind: string, list: readonly ts.Signature[]) => list.map((sig) => `${kind}${typeParams(sig.getTypeParameters(), from)}(${sig.getParameters().map(param).join(", ")}) => ${print(sig.getReturnType(), from)}`);
    const members = [
      ...checker.getIndexInfosOfType(t).map((i) => `[key: ${print(i.keyType, from)}]: ${print(i.type, from)}`),
      ...checker.getPropertiesOfType(t).map((p) => `${isReadonly(p) ? "readonly " : ""}${p.name}${p.flags & ts.SymbolFlags.Optional ? "?" : ""}: ${print(checker.getTypeOfSymbol(p), from)}`).sort(),
    ];
    const calls = [...signatures("", t.getCallSignatures()), ...signatures("new ", t.getConstructSignatures())];
    if (members.length === 0 && calls.length === 1) return calls[0];
    return `{ ${[...calls, ...members].map((m) => `${m};`).join(" ")} }`;
  };

  const typeParams = (list: readonly ts.TypeParameter[] | undefined, from: string): string => {
    const one = (tp: ts.TypeParameter) => {
      const constraint = tp.getConstraint();
      const fallback = tp.getDefault();
      return `${tp.symbol.name}${constraint ? ` extends ${print(constraint, from)}` : ""}${fallback ? ` = ${print(fallback, from)}` : ""}`;
    };
    return list?.length ? `<${list.map(one).join(", ")}>` : "";
  };
  const isReadonly = (p: ts.Symbol) => (p.declarations ?? []).some((d) => ts.getCombinedModifierFlags(d as ts.Declaration) & ts.ModifierFlags.Readonly);
  /** The type parameters a type declaration introduces (`interface Box<T>`, `type Pair<A, B = A>`). */
  const declaredTypeParams = (s: ts.Symbol, from: string) =>
    typeParams((s.declarations ?? []).flatMap((d) => [...(ts.getEffectiveTypeParameterDeclarations(d as ts.DeclarationWithTypeParameters) ?? [])]).map((tp) => checker.getTypeAtLocation(tp) as ts.TypeParameter).filter((tp, i, all) => all.findIndex((o) => o.symbol.name === tp.symbol.name) === i), from);

  const names: Surface["names"] = {};
  for (const s of [...exports].sort((a, b) => a.name.localeCompare(b.name))) {
    const target = resolve(s);
    const isValue = !!(target.flags & ts.SymbolFlags.Value);
    const isType = !!(target.flags & ts.SymbolFlags.Type);
    const parts = [
      ...(isValue ? [print(checker.getTypeOfSymbol(target), s.name)] : []),
      ...(isType ? [declaredTypeParams(target, s.name) + print(checker.getDeclaredTypeOfSymbol(target), s.name, true)] : []),
    ];
    names[s.name] = { kind: meanings({ [s.name]: isType }, isValue ? { [s.name]: true } : {})[s.name], signature: parts.join(" & type ") };
  }
  const unexported = [...reached].filter(([sym]) => !publicTypes.has(sym)).map(([sym, from]) => `${sym.name} (named by ${from})`).sort();
  const lines = Object.entries(names).map(([n, e]) => `${n} ${e.kind}: ${e.signature}`);
  return { surface: { sha256: createHash("sha256").update(lines.join("\n")).digest("hex"), names }, unexported };
}

/** One line per difference: added, removed, changed kind, changed signature. */
export function surfaceDiff(frozen: Surface, current: Surface): string[] {
  const out: string[] = [];
  for (const [n, e] of Object.entries(current.names)) {
    const was = frozen.names[n];
    if (!was) out.push(`added public name ${n} (${e.kind}): ${e.signature}`);
    else if (was.kind !== e.kind) out.push(`${n} changed kind: ${was.kind} -> ${e.kind}`);
    else if (was.signature !== e.signature) out.push(`${n} changed signature:\n  was: ${was.signature}\n  now: ${e.signature}`);
  }
  for (const n of Object.keys(frozen.names)) if (!current.names[n]) out.push(`removed public name ${n}`);
  if (out.length === 0 && frozen.sha256 !== current.sha256) out.push(`sha256 differs with no name-level change: ${frozen.sha256} -> ${current.sha256}`);
  return out;
}

if (import.meta.main) {
  const { surface, unexported } = readSurface();
  if (unexported.length > 0) {
    console.error(`public signatures name types that ${API_ENTRY} does not export:\n${unexported.join("\n")}`);
    process.exit(1);
  }
  if (process.argv[2] === "--update") {
    writeFileSync(SURFACE_PATH, `${JSON.stringify(surface, null, 2)}\n`);
    console.log(`wrote ${Object.keys(surface.names).length} public names to ${path.relative(ROOT, SURFACE_PATH)}`);
  } else console.log(JSON.stringify(surface, null, 2));
}

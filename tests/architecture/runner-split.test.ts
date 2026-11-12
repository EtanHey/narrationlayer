import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { trackedSources } from "../../scripts/dev/importers.js";

const root = path.resolve(import.meta.dir, "../..");

/** Every file that declares each name, by name across kinds (lead ruling R6, PR #59): a function, a variable holding a
 * function or arrow, a type alias, an interface, a class method (static or instance) or a class property holding a
 * function, an object-literal method or function-valued property. */
function declaredNames(files: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const isFn = (e: ts.Expression | undefined): boolean => {
    while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression;
    return !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
  };
  const text = (n: ts.Node | undefined) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) ? n.text : undefined);
  for (const [file, source] of Object.entries(files)) {
    const visit = (node: ts.Node): void => {
      const name =
        (ts.isFunctionDeclaration(node) && node.body) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || (ts.isMethodDeclaration(node) && node.body) ? text(node.name)
        : (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && isFn(node.initializer) ? text(node.name)
        : undefined;
      if (name) out.set(name, [...(out.get(name) ?? []), file]);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  }
  return out;
}

// Tracked files only (R6), like the importer rule: a stray untracked file in a worktree does not count.
const files = trackedSources().filter((f) => f.startsWith("src/") || f.startsWith("bin/"));
const declarations = declaredNames(Object.fromEntries(files.map((f) => [f, readFileSync(path.join(root, f), "utf8")])));

const groups = [
  ["audio builders", "src/audio/ffmpeg-args.ts", ["buildMonoS16WavArgs", "computeLoudnessGainDb", "buildLoudnessNormalizeArgs", "buildAtempoArgs", "buildPcmSilenceArgs", "buildWavConcatArgs"]],
  ["breathing plan", "src/plan/breathing.ts", ["splitForBreathing"]],
  ["take cache", "src/pipelines/local-tts/take-cache.ts", ["CacheKeyParams", "computeContentHashKey", "writeTakeCacheReceipt", "clearTakeCacheReceipt"]],
] satisfies Array<[string, string, string[]]>;

for (const [group, home, names] of groups) {
  test(`runner ${group} are declared once in their library module`, () => {
    for (const name of names) expect(declarations.get(name), name).toEqual([home]);
  });
}

// A second copy in any declaring form is counted; the static-method copy is the round 1 reviewer's (recon/PR59-rv25).
test.each([
  ["function", "export function splitForBreathing(t: string) { return [t]; }"],
  ["const arrow", "export const splitForBreathing = (t: string) => [t];"],
  ["const function expression", "export const splitForBreathing = function (t: string) { return [t]; };"],
  ["type alias", "export type splitForBreathing = string[];"],
  ["interface", "export interface splitForBreathing { t: string }"],
  ["static method", "export class Runner { static splitForBreathing(t: string) { return [t]; } }"],
  ["instance method", "export class Runner { splitForBreathing(t: string) { return [t]; } }"],
  ["class property arrow", "export class Runner { splitForBreathing = (t: string) => [t]; }"],
  ["object-literal method", "export const runner = { splitForBreathing(t: string) { return [t]; } };"],
  ["object-literal function property", "export const runner = { splitForBreathing: function (t: string) { return [t]; } };"],
])("a second copy written as a %s is counted", (_kind, copy) => {
  const found = declaredNames({ "src/plan/breathing.ts": "export function splitForBreathing(t: string) { return [t]; }\n", "bin/copy.ts": copy });
  expect(found.get("splitForBreathing")).toEqual(["src/plan/breathing.ts", "bin/copy.ts"]);
});

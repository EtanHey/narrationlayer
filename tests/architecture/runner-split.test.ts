import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

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
  const text = (n: ts.Node | undefined) => {
    if (n && ts.isComputedPropertyName(n)) return ts.isStringLiteralLike(n.expression) ? n.expression.text : undefined;
    return n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) ? n.text : undefined;
  };
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
const tracked = spawnSync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "utf8", timeout: 20_000 });
if (tracked.status !== 0) throw new Error(`git ls-files failed: ${tracked.stderr}`);
const files = tracked.stdout.split("\0").filter((f) => /^(src|bin)\/.*\.(?:[cm]?[jt]s|[jt]sx)$/.test(f));
const declarations = declaredNames(Object.fromEntries(files.map((f) => [f, readFileSync(path.join(root, f), "utf8")])));

const groups = [
  ["audio builders", "src/audio/ffmpeg-args.ts", ["buildMonoS16WavArgs", "computeLoudnessGainDb", "buildLoudnessNormalizeArgs", "buildAtempoArgs", "buildPcmSilenceArgs", "buildWavConcatArgs"]],
  ["breathing plan", "src/plan/breathing.ts", ["splitForBreathing"]],
  ["take cache", "src/pipelines/local-tts/take-cache.ts", ["CacheKeyParams", "computeContentHashKey", "writeTakeCacheReceipt", "clearTakeCacheReceipt"]],
  ["audio execution", "src/audio/ffmpeg-run.ts", ["ffmpegRun", "ffmpegToMonoS16Wav", "ffmpegAtempo", "measureMeanVolumeDb", "ffmpegLoudnessNormalize"]],
  ["synthesis", "src/pipelines/local-tts/synthesis.ts", ["synthesize"]],
  ["breathing stage", "src/pipelines/local-tts/breathing.ts", ["applyBreathingInPlace"]],
  ["loudness stage", "src/pipelines/local-tts/loudness.ts", ["loudnessNormalizeInPlace"]],
  ["render sequence", "src/pipelines/local-tts/index.ts", ["renderLocalTts"]],
] satisfies Array<[string, string, string[]]>;

for (const [group, home, names] of groups) {
  test(`runner ${group} are declared once in their library module`, () => {
    for (const name of names) expect(declarations.get(name), name).toEqual([home]);
  }, 30_000);
}

test("runner entry delegates synthesis and ffmpeg; library stages never exit or read argv", () => {
  const isProcess = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === "process") ||
    (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "globalThis" && node.name.text === "process");
  for (const file of files) {
    if (file !== "bin/local-tts-runner.ts" && !/src\/(?:pipelines\/local-tts|audio)\//.test(file)) continue;
    const source = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (file === "bin/local-tts-runner.ts") {
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
          expect(node.moduleSpecifier.text.replace(/^node:/, ""), file).not.toBe("child_process");
        }
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Bun") {
          expect(node.name.text, file).not.toMatch(/^spawn(?:Sync)?$/);
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          expect(["spawn", "synthesizeQwen3"], file).not.toContain(node.expression.text);
        }
      } else if (ts.isVariableDeclaration(node) && node.initializer && isProcess(node.initializer) && ts.isObjectBindingPattern(node.name)) {
        expect(ts.isObjectBindingPattern(node.name), file).toBe(false);
      } else if (ts.isPropertyAccessExpression(node) && isProcess(node.expression)) {
        expect(["exit", "argv", "stdout", "stderr"], file).not.toContain(node.name.text);
      } else if (ts.isElementAccessExpression(node) && isProcess(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) {
        expect(["exit", "argv", "stdout", "stderr"], file).not.toContain(node.argumentExpression.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

// A second copy in any declaring form is counted; the static-method copy is the round 1 reviewer's (recon/PR59-rv25).
test.each([
  ["function", "export function splitForBreathing(t: string) { return [t]; }"],
  ["const arrow", "export const splitForBreathing = (t: string) => [t];"],
  ["const function expression", "export const splitForBreathing = function (t: string) { return [t]; };"],
  ["type alias", "export type splitForBreathing = string[];"],
  ["interface", "export interface splitForBreathing { t: string }"],
  ["static method", "export class Runner { static splitForBreathing(t: string) { return [t]; } }"],
  ["computed static method", 'export class Runner { static ["splitForBreathing"](t: string) { return [t]; } }'],
  ["instance method", "export class Runner { splitForBreathing(t: string) { return [t]; } }"],
  ["class property arrow", "export class Runner { splitForBreathing = (t: string) => [t]; }"],
  ["object-literal method", "export const runner = { splitForBreathing(t: string) { return [t]; } };"],
  ["object-literal function property", "export const runner = { splitForBreathing: function (t: string) { return [t]; } };"],
])("a second copy written as a %s is counted", (_kind, copy) => {
  const found = declaredNames({ "src/plan/breathing.ts": "export function splitForBreathing(t: string) { return [t]; }\n", "bin/copy.ts": copy });
  expect(found.get("splitForBreathing")).toEqual(["src/plan/breathing.ts", "bin/copy.ts"]);
});

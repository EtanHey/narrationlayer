import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../..");
const declarations = new Map<string, string[]>();
for (const dir of ["src", "bin"]) {
  for (const file of new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}").scanSync({ cwd: path.join(root, dir), absolute: true })) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    // A second copy counts in any declaring form: function, interface, type alias, or a const holding a function.
    const copyName = (node: ts.Node): string | undefined => {
      if ((ts.isFunctionDeclaration(node) && node.body || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) return node.name.text;
      let init = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.initializer : undefined;
      while (init && (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) init = init.expression;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return ((node as ts.VariableDeclaration).name as ts.Identifier).text;
    };
    const visit = (node: ts.Node): void => {
      const name = copyName(node);
      if (name) {
        declarations.set(name, [...declarations.get(name) ?? [], path.relative(root, file)]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

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

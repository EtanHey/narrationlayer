import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../..");
const declarations = new Map<string, string[]>();
for (const dir of ["src", "bin"]) {
  for (const file of new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}").scanSync({ cwd: path.join(root, dir), absolute: true })) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) && node.body || ts.isInterfaceDeclaration(node)) && node.name) {
        const name = node.name.text;
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

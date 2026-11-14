import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

// Whole-program type-check cost grows with the source tree; hosted runners are about 3x slower.
test("exactly one module constructs daemon HTTP requests", () => {
  const root = path.resolve(import.meta.dir, "../..");
  const files = ["src", "bin"].flatMap(dir => [...new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}").scanSync({ cwd: path.join(root, dir), absolute: true })]);
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const program = ts.createProgram(files, { ...options, allowJs: true });
  const checker = program.getTypeChecker();
  const modules = new Set<string>();
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`Missing syntax tree: ${file}`);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        // Inspect the transport signature, not the callee spelling or URL literal.
        // Aliases, injected fetch, and URLs stored in variables still count. Until
        // another HTTP backend exists, every Response-returning transport belongs here.
        const returnsResponse = signature && checker.typeToString(checker.getReturnTypeOfSignature(signature)) === "Promise<Response>";
        if (returnsResponse) modules.add(path.relative(root, file));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect([...modules].sort()).toEqual(["src/backends/qwen3-daemon.ts"]);
}, 30_000);

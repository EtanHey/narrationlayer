import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../..");

/** Every `spawnSync(` / `.spawnSync(` call in the given sources whose arguments hold no object literal with a `timeout`
 * key. A test's budget cannot interrupt a blocked synchronous child, so the child's own timeout is the only stop. A call
 * that passes its options through a helper is checked where the helper calls spawnSync. */
export function untimedSpawnSyncs(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        const timed = node.arguments.some((arg) => ts.isObjectLiteralExpression(arg) && arg.properties.some((p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === "timeout"));
        if (name === "spawnSync" && !timed) out.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

test("every spawnSync in the tests carries a child timeout in its options", () => {
  const tracked = spawnSync("git", ["ls-files", "-z", "--cached", "tests", "packages"], { cwd: root, encoding: "utf8", timeout: 20_000 });
  if (tracked.error) throw tracked.error;
  expect(tracked.status, tracked.stderr).toBe(0);
  const files = tracked.stdout.split("\0").filter((f) => /^tests\/.*\.[cm]?[jt]s$/.test(f) || /^packages\/.*\.test\.[cm]?[jt]s$/.test(f));
  expect(untimedSpawnSyncs(Object.fromEntries(files.map((f) => [f, readFileSync(path.join(root, f), "utf8")])))).toEqual([]);
}, 30_000);

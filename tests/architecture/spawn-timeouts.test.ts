import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../..");

// A regex, not a string, so the guard's own source holds no mention it would have to account for.
const isName = (text: string) => /^spawnSync$/.test(text);
const UNTIMED = "spawnSync call with no `timeout` key in an object-literal options argument";
const UNCHECKABLE = "spawnSync is used in a form this guard cannot check (alias, renamed import, destructuring, call/apply/bind, passed as a value): call it directly with a timeout";

/** Every mention of spawnSync in the given sources that is not accounted for, as `file:line reason`. A mention is
 * accounted for when it names the callee of a direct call (bare, property, or literal-key element access, through
 * parentheses, type assertions and `!`) whose arguments hold an object literal with a `timeout` key, or when it is a
 * same-name import specifier. A test's budget cannot interrupt a blocked synchronous child, so the child's own timeout
 * is the only stop; a call that passes its options through a helper is checked where the helper calls spawnSync. */
export function untimedSpawnSyncs(files: Record<string, string>): string[] {
  const out: string[] = [];
  const unwrap = (e: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    return e;
  };
  const calleeName = (callee: ts.Expression): ts.Node | undefined => {
    const e = unwrap(callee);
    return ts.isIdentifier(e) ? e : ts.isPropertyAccessExpression(e) ? e.name
      : ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression : undefined;
  };
  for (const [file, source] of Object.entries(files)) {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const at = (node: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    const accounted = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && isName(name.text)) {
          accounted.add(name);
          const timed = node.arguments.some((arg) => ts.isObjectLiteralExpression(arg) && arg.properties.some((p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === "timeout"));
          if (!timed) out.push(`${at(node)} ${UNTIMED}`);
        }
      }
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && isName(node.text) && !accounted.has(node)
        && !(ts.isImportSpecifier(node.parent) && node.parent.name === node && !node.parent.propertyName)) out.push(`${at(node)} ${UNCHECKABLE}`);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

const U = "untimed", X = "uncheckable";
test.each([
  ["bare call", `spawnSync("git", ["status"]);`, U],
  ["property call", `Bun.spawnSync(["git", "status"]);`, U],
  ["element-access call", `Bun["spawnSync"](["sleep", "37"]);`, U],
  ["element-access call, template key", "child_process[`spawnSync`](\"git\", []);", U],
  ["options in a variable", `spawnSync("git", [], options);`, U],
  ["options only through a spread", `Bun.spawnSync(["git"], { ...options });`, U],
  ["parenthesised callee", `(Bun.spawnSync)(["sleep", "37"]);`, U],
  ["type-asserted callee", `(spawnSync as any)("git", []);`, U],
  ["non-null callee", `Bun.spawnSync!(["git"]);`, U],
  ["alias", `const run = Bun.spawnSync;`, X],
  ["renamed import", `import { spawnSync as run } from "node:child_process";`, X],
  ["destructuring", `const { spawnSync: run } = Bun;`, X],
  [".call", `Bun.spawnSync.call(Bun, ["git"]);`, X],
  ["passed as a value", `[1].map(spawnSync);`, X],
  ["bare call with timeout", `spawnSync("git", ["status"], { timeout: 1000 });`, ""],
  ["property call with timeout", `Bun.spawnSync(["git", "status"], { timeout: 1000 });`, ""],
  ["element-access call with timeout", `Bun["spawnSync"](["sleep", "37"], { timeout: 1000 });`, ""],
  ["parenthesised callee with timeout", `(Bun.spawnSync)(["sleep", "37"], { timeout: 1000 });`, ""],
  ["same-name import", `import { spawnSync } from "node:child_process";`, ""],
] as const)("untimedSpawnSyncs: %s", (_label, source, kind) => {
  expect(untimedSpawnSyncs({ "fixture.ts": source })).toEqual(kind === "" ? [] : [`fixture.ts:1 ${kind === U ? UNTIMED : UNCHECKABLE}`]);
});

test("every spawnSync in the tests carries a child timeout in its options", () => {
  const tracked = spawnSync("git", ["ls-files", "-z", "--cached", "tests", "packages"], { cwd: root, encoding: "utf8", timeout: 20_000 });
  if (tracked.error) throw tracked.error;
  expect(tracked.status, tracked.stderr).toBe(0);
  const files = tracked.stdout.split("\0").filter((f) => /^tests\/.*\.[cm]?[jt]s$/.test(f) || /^packages\/.*\.test\.[cm]?[jt]s$/.test(f));
  expect(untimedSpawnSyncs(Object.fromEntries(files.map((f) => [f, readFileSync(path.join(root, f), "utf8")])))).toEqual([]);
}, 30_000);

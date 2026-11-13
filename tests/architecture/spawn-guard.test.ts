// Synchronous spawns in tests go through tests/support/spawn.ts, whose helpers require a timeout.
// The rule is textual and specified by construction: the names below may not appear ANYWHERE in a tracked test file
// (code, string, comment, any syntax) other than the helper module. No call parsing, no list of call forms.
// It cannot see: a name assembled at run time, and synchronous APIs not on the list (execSync and Bun.$ are left off
// because tracked tests use them today: tests/realbrowser/seek-realbrowser.mjs, tests/cli.test.ts, tests/qwen3-lora.test.ts).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { nodeSpawnChecked, spawnChecked } from "../support/spawn.js";

const root = path.resolve(import.meta.dir, "../..");
// Written so that this file does not itself contain the names it forbids.
const FORBIDDEN = /spawn[S]ync|exec[F]ileSync/g;
const HELPERS = new Set(["tests/support/spawn.ts"]);
// Files left out on purpose, each with its reason. Empty: PR #75 touches no file this rule covers.
const EXCEPTIONS = new Map<string, string>();

test("no tracked test file names a synchronous spawn outside tests/support/spawn.ts", () => {
  const listed = nodeSpawnChecked("git", ["ls-files", "-z", "--", "tests", ":(glob)packages/**/*.test.*"], { cwd: root, timeout: 20_000 });
  expect(listed.status, listed.stderr).toBe(0);
  const files = listed.stdout.split("\0").filter(Boolean);
  expect(files).toContain("tests/support/spawn.ts");
  expect(files).toContain("packages/dashboard-publish/answers-export-capsule.test.ts");
  const found: string[] = [];
  for (const file of files) {
    if (HELPERS.has(file) || EXCEPTIONS.has(file)) continue;
    const lines = readFileSync(path.join(root, file), "latin1").split("\n");
    lines.forEach((line, i) => { for (const m of line.matchAll(FORBIDDEN)) found.push(`${file}:${i + 1}: ${m[0]}`); });
  }
  expect(found).toEqual([]);
}, 30_000);

test("the helpers' timeout cannot be skipped: the type checker rejects a call without one and run time refuses it", () => {
  // @ts-expect-error timeout is required (checked by `bunx tsc --noEmit`)
  expect(() => nodeSpawnChecked("true", [], {})).toThrow("true: a synchronous spawn needs a positive finite timeout, got undefined");
  // @ts-expect-error timeout is required (checked by `bunx tsc --noEmit`)
  expect(() => spawnChecked(["true"], {})).toThrow("true: a synchronous spawn needs a positive finite timeout, got undefined");
  const bypass: any = { timeout: undefined };
  expect(() => nodeSpawnChecked("true", [], bypass)).toThrow("needs a positive finite timeout, got undefined");
  expect(() => spawnChecked(["true"], bypass)).toThrow("needs a positive finite timeout, got undefined");
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => nodeSpawnChecked("true", [], { timeout })).toThrow("needs a positive finite timeout");
    expect(() => spawnChecked(["true"], { timeout })).toThrow("needs a positive finite timeout");
  }
});

test("a helper call that outlives its timeout throws, naming the command", () => {
  expect(() => nodeSpawnChecked("sleep", ["5"], { timeout: 200 })).toThrow(/^sleep 5: .*ETIMEDOUT/);
  expect(() => spawnChecked(["sleep", "5"], { timeout: 200 })).toThrow("sleep 5: timed out after 200 ms");
  expect(() => nodeSpawnChecked("nl-no-such-command", [], { timeout: 2000 })).toThrow(/^nl-no-such-command: /);
  expect(nodeSpawnChecked("sh", ["-c", "echo out; echo err >&2; exit 3"], { timeout: 2000 })).toEqual({ status: 3, stdout: "out\n", stderr: "err\n" });
}, 10_000);

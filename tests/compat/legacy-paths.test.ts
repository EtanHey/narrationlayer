// Invariant I-A: every module path and exported name that existed at f7faa867 still resolves.
// Manifest: tests/compat/legacy-paths.manifest.json, written by scripts/dev/snapshot-exports.ts.
import { expect, test } from "bun:test";
import path from "node:path";

import { readJson, ROOT } from "../../scripts/dev/boundaries.js";
import { checkerExports, MANIFEST_PATH, type Manifest } from "../../scripts/dev/snapshot-exports.js";

const manifest = readJson<Manifest>(MANIFEST_PATH);
const seen = checkerExports(Object.keys(manifest));

test("the legacy-path manifest covers src/ and bin/ modules", () => {
  expect(Object.keys(manifest)).toContain("src/schema.ts");
  expect(Object.keys(manifest)).toContain("bin/local-tts-runner.ts");
});

for (const [file, { values, types }] of Object.entries(manifest)) {
  test(`${file} still resolves with every frozen export`, async () => {
    const mod = (await import(path.join(ROOT, file))) as Record<string, unknown>;
    expect(values.filter((name) => !(name in mod))).toEqual([]);
    expect([...values, ...types].filter((name) => !seen[file].includes(name))).toEqual([]);
  });
}

// Invariant I-A: every module path, exported name and export meaning (value, type or both) that existed at f7faa867
// still resolves. Manifest: tests/compat/legacy-paths.manifest.generated.json, written by scripts/dev/snapshot-exports.ts.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readJson, ROOT } from "../../scripts/dev/boundaries.js";
import { lostMeanings, MANIFEST_PATH, meanings, typeSides, type Manifest } from "../../scripts/dev/snapshot-exports.js";

const manifest = readJson<Manifest>(MANIFEST_PATH);
const types = typeSides(Object.keys(manifest));

test("the legacy-path manifest covers src/ and bin/ modules", () => {
  expect(Object.keys(manifest)).toContain("src/schema.ts");
  expect(Object.keys(manifest)).toContain("bin/local-tts-runner.ts");
});

for (const [file, frozen] of Object.entries(manifest)) {
  test(`${file} still resolves with every frozen export and its meaning`, async () => {
    const mod = (await import(path.join(ROOT, file))) as object;
    expect(lostMeanings(frozen, meanings(types[file], mod))).toEqual([]);
  });
}

test("a frozen name that keeps its spelling but changes meaning fails, in both directions", async () => {
  mkdirSync(path.join(ROOT, "dist"), { recursive: true }); // dist/ is gitignored
  const dir = path.relative(ROOT, mkdtempSync(path.join(ROOT, "dist", ".meanings-")));
  const variants = {
    before: "export type SpeechPreparation = (s: string) => string;\nexport const keep = 1;\n",
    // PR #47 round-1 reviewer mutation: the public type goes private and a value takes its name.
    typeToValue: "type PrivateSpeechPreparation = (s: string) => string;\nexport const SpeechPreparation = undefined;\nexport const keep = 1;\n",
    // Mirror: a frozen value replaced by a same-named type.
    valueToType: "export type SpeechPreparation = (s: string) => string;\nexport type keep = number;\n",
    // PR #47 round-2 reviewer cases: a value erased at runtime, and a namespace, must not stand in for the frozen type.
    typeOnlyValue: "type PrivateSpeechPreparation = (s: string) => string;\nconst SpeechPreparation = undefined;\nexport type { SpeechPreparation };\nexport const keep = 1;\n",
    namespace: "type PrivateSpeechPreparation = (s: string) => string;\nexport namespace SpeechPreparation { export const n = 1; }\nexport const keep = 1;\n",
    kinds: "export class Both {}\nexport const Merged = 1;\nexport type Merged = number;\nclass Hidden {}\nexport type { Hidden };\n",
  };
  try {
    for (const [name, source] of Object.entries(variants)) writeFileSync(path.join(ROOT, dir, `${name}.ts`), source);
    const files = Object.keys(variants).map((name) => `${dir}/${name}.ts`);
    const sides = typeSides(files);
    const [before, typeToValue, valueToType, typeOnlyValue, namespace, kinds] = await Promise.all(files.map(async (f) => meanings(sides[f], await import(path.join(ROOT, f)))));
    expect(before).toEqual({ SpeechPreparation: "type", keep: "value" });
    expect(lostMeanings(before, typeToValue)).toEqual(["SpeechPreparation lost its type meaning (was type, now value)"]);
    expect(lostMeanings(before, valueToType)).toEqual(["keep lost its value meaning (was value, now type)"]);
    expect(lostMeanings(before, typeOnlyValue)).toEqual(["SpeechPreparation lost its type meaning (was type, now none)"]);
    expect(lostMeanings(before, namespace)).toEqual(["SpeechPreparation lost its type meaning (was type, now value)"]);
    expect(kinds).toEqual({ Both: "both", Merged: "both", Hidden: "type" }); // a type-only export of a class is a type
    expect(lostMeanings(kinds, { ...kinds, Both: "value" })).toEqual(["Both lost its type meaning (was both, now value)"]);
  } finally {
    rmSync(path.join(ROOT, dir), { recursive: true, force: true });
  }
});

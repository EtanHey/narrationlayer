// The package's front door: package.json `exports` is "." (src/api/index.ts), "./package.json", and every legacy module
// frozen in tests/compat/legacy-paths.manifest.generated.json (invariant I-A), listed one by one. Nothing else resolves by name.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as api from "../../src/api/index.js"; // tests may import the front door; nothing under src/, bin/ or scripts/ may
import { readJson, ROOT } from "../../scripts/dev/boundaries.js";
import { legacyModules, MANIFEST_PATH, type Manifest } from "../../scripts/dev/snapshot-exports.js";
import { SURFACE_PATH, type Surface } from "../../scripts/dev/snapshot-surface.js";

const pkg = readJson<{ name: string; exports: Record<string, string> }>(path.join(ROOT, "package.json"));
const legacy = Object.keys(readJson<Manifest>(MANIFEST_PATH)).sort();

test("exports is exactly the front door, package.json and the frozen legacy modules", () => {
  const expected = { ".": "./src/api/index.ts", "./package.json": "./package.json", ...Object.fromEntries(legacy.map((f) => [`./${f}`, `./${f}`])) };
  expect(pkg.exports).toEqual(expected);
});

test("by package name, from a scratch consumer: the front door and legacy subpaths resolve, no other module does", () => {
  mkdirSync(path.join(ROOT, "dist"), { recursive: true }); // dist/ is gitignored
  const dir = mkdtempSync(path.join(ROOT, "dist", ".exports-"));
  try {
    // A consumer with its own package.json and the package linked into its node_modules, as a file: or link install would leave it.
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "scratch-consumer", type: "module", private: true })}\n`);
    mkdirSync(path.join(dir, "node_modules"));
    symlinkSync(ROOT, path.join(dir, "node_modules", pkg.name), "dir");
    const specifiers = [pkg.name, `${pkg.name}/package.json`, ...legacyModules().map((f) => `${pkg.name}/${f}`)];
    const probe = `const out = {};\nfor (const s of ${JSON.stringify(specifiers)}) { try { out[s] = new URL(import.meta.resolve(s)).pathname; } catch { out[s] = null; } }\nout.values = Object.keys(await import(${JSON.stringify(pkg.name)})).sort();\nconsole.log(JSON.stringify(out));\n`;
    writeFileSync(path.join(dir, "probe.ts"), probe);
    const run = spawnSync(process.execPath, ["probe.ts"], { cwd: dir, encoding: "utf8", timeout: 20000 });
    expect(run.stderr).toBe("");
    const resolved = JSON.parse(run.stdout) as Record<string, string | null> & { values: string[] };
    const real = (f: string) => path.join(ROOT, f);
    expect(resolved[pkg.name]).toBe(real("src/api/index.ts"));
    expect(resolved[`${pkg.name}/package.json`]).toBe(real("package.json"));
    const reachable = legacyModules().filter((f) => resolved[`${pkg.name}/${f}`] === real(f));
    const blocked = legacyModules().filter((f) => resolved[`${pkg.name}/${f}`] === null);
    expect(reachable).toEqual(legacy);
    expect(blocked).toEqual(legacyModules().filter((f) => !legacy.includes(f))); // src/api/index.ts, src/plan/**, src/pipelines/**, …
    expect(blocked).toContain("src/plan/index.ts");
    const surface = readJson<Surface>(SURFACE_PATH);
    expect(resolved.values).toEqual(Object.keys(surface.names).filter((n) => surface.names[n].kind !== "type").sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the front door's runtime values are the snapshot's value names", () => {
  const surface = readJson<Surface>(SURFACE_PATH);
  expect(Object.keys(api).sort()).toEqual(Object.keys(surface.names).filter((n) => surface.names[n].kind !== "type").sort());
});

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../../scripts/dev/boundaries.js";
import { declarationClosure, readSurface, surfaceDiff } from "../../scripts/dev/snapshot-surface.js";

function fixture(run: (root: string, write: (file: string, text: string) => void) => void): void {
  mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "dist", ".surface-inputs-"));
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  try { run(root, write); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("repo-authored declaration inputs reached by a public parameter are hashed (.d.ts, .d.mts, .d.cts)", () => {
  fixture((root, write) => {
    for (const [extension, specifier] of [["ts", "js"], ["mts", "mjs"], ["cts", "cjs"]]) {
      const shape = `src/review-shapes.d.${extension}`;
      write(shape, "export interface ReviewPub { n: number }\n");
      write("src/types.ts", `export type ReviewBox = import("./review-shapes.${specifier}").ReviewPub;
export function reviewProbe(v: ReviewBox): void {}
export type { ReviewPub } from "./review-shapes.${specifier}";
`);
      write("src/api.ts", 'export { reviewProbe, type ReviewBox, type ReviewPub } from "./types.js";\n');
      const before = readSurface("src/api.ts", root);
      expect(before.unexported).toEqual([]);
      expect(before.thirdParty).toEqual([]);
      expect(before.surface.files[shape]).toBeDefined();
      write(shape, "export interface ReviewPub { n: string }\n");
      const after = readSurface("src/api.ts", root);
      expect(after.surface.sha256).not.toBe(before.surface.sha256);
      expect(surfaceDiff(before.surface, after.surface).join("\n")).toContain("ReviewPub changed declaration");
      write(shape, "export interface ReviewPub { n: number }\n");
      expect(readSurface("src/api.ts", root).surface).toEqual(before.surface);

      // The original probe kept ReviewPub private: it must now name the public signature that exposes it.
      write("src/api.ts", 'export { reviewProbe, type ReviewBox } from "./types.js";\n');
      expect(readSurface("src/api.ts", root).unexported).toContain("ReviewPub (named by ReviewBox)");
    }
  });
}, 60_000);

test("a reached repo declaration that cannot be emitted or read fails with its filename", () => {
  fixture((root, write) => {
    write("src/api.ts", 'export type ReviewBox = import("./missing-shapes.js").ReviewPub;\n');
    expect(() => readSurface("src/api.ts", root)).toThrow("cannot emit or read reached repo file src/missing-shapes.js");
    expect(() => declarationClosure(new Map(), "src/missing.ts", root)).toThrow("src/missing.d.ts");
  });
}, 60_000);

test("dependency export targets fail closed, including type-only and chained computed-key re-exports", () => {
  fixture((root, write) => {
    write("node_modules/probe-dep/package.json", '{"name":"probe-dep","types":"index.d.ts"}\n');
    for (const key of ["a", "b"]) {
      write("node_modules/probe-dep/index.d.ts", `export declare const key: "${key}";\nexport interface Dep { [key]: number }\n`);
      for (const typeOnly of ["", "type "]) {
        const exports = `export ${typeOnly}{ Dep as ReviewDep } from "probe-dep";\n`;
        write("src/types.ts", exports);
        for (const entry of [exports, `export ${typeOnly}{ ReviewDep } from "./types.js";\n`]) {
          write("src/api.ts", entry);
          expect(readSurface("src/api.ts", root).thirdParty).toContain("ReviewDep names Dep from probe-dep");
        }
      }
    }
  });
}, 60_000);

test("internal export addition or reorder names the reached file without claiming a public name changed", () => {
  fixture((root, write) => {
    const publicPart = "export function reviewProbe(): number { return 1; }\n";
    const a = "export function internalA(): number { return 2; }\n";
    const b = "export function internalB(): number { return 3; }\n";
    write("src/api.ts", 'export { reviewProbe } from "./types.js";\n');
    write("src/types.ts", publicPart + a + b);
    const before = readSurface("src/api.ts", root).surface;
    for (const text of [publicPart + a + b + "export const internalC = 4;\n", publicPart + b + a]) {
      write("src/types.ts", text);
      const after = readSurface("src/api.ts", root).surface;
      expect(after.names).toEqual(before.names);
      expect(after.sha256).not.toBe(before.sha256);
      expect(surfaceDiff(before, after)).toEqual([
        "no public name changed; the declaration file src/types.d.ts that the surface reaches changed; if that is intended, regenerate with `bun scripts/dev/snapshot-surface.ts --update`",
      ]);
    }
    write("src/types.ts", (publicPart + a + b).replace("reviewProbe(): number", "reviewProbe(): unknown"));
    expect(surfaceDiff(before, readSurface("src/api.ts", root).surface).join("\n")).toContain("reviewProbe changed declaration");
  });
}, 60_000);

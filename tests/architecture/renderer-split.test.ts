import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { importSpecifiers, ROOT } from "../../scripts/dev/boundaries.js";

test.each(["fake", "external-command"])("%s has no import edge to the Qwen3 renderer or pipelines", (name) => {
  const file = path.join(ROOT, "src/renderers", `${name}.ts`);
  const forbidden = importSpecifiers(readFileSync(file, "utf8"), file).filter((specifier) => {
    if (!specifier.startsWith(".")) return false;
    const target = path.resolve(path.dirname(file), specifier).replace(/\.(?:m?js|ts)$/, "");
    return target === path.join(ROOT, "src/renderers/voicelayer-qwen3") ||
      target === path.join(ROOT, "src/pipelines") || target.startsWith(path.join(ROOT, "src/pipelines") + path.sep);
  });
  expect(forbidden).toEqual([]);
});

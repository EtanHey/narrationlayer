import { test, expect } from "bun:test";
import { importClosure } from "../../scripts/dev/importers.js";

// Follows the whole import closure, not only direct imports: a helper in between does not hide a Qwen3 or pipeline edge.
test.each(["fake", "external-command"])("%s reaches neither the Qwen3 renderer nor the pipelines through any chain of imports", (name) => {
  const forbidden = importClosure(`src/renderers/${name}.ts`).filter((f) => f === "src/renderers/voicelayer-qwen3.ts" || f.startsWith("src/pipelines/"));
  expect(forbidden).toEqual([]);
});

import { expect, test } from "bun:test";
import { diskRepo, importSpecifiers, resolveImport } from "../../scripts/dev/boundaries.js";
test("the temporary conformance command is never imported by source or tests", () => {
  const repo = diskRepo();
  const incoming = [...repo.tracked].filter(f => /^(src|tests)\/.*\.[cm]?[jt]sx?$/.test(f)).flatMap(f =>
    importSpecifiers(repo.read(f) ?? "", f).filter(spec => resolveImport(repo, f, spec) === "src/engine/conformance/cli.ts").map(spec => `${f}: ${spec}`));
  expect(incoming).toEqual([]);
});

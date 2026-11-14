import { test, expect } from "bun:test";
import engine from "../../src/engine/conformance/engine-binding";
import brokenSeek from "../../src/engine/conformance/broken-seek-01";
import brokenId from "../../src/engine/conformance/broken-id-01e";
import { runCase, cases } from "../../src/engine/conformance/runner";
for (const [id, broken] of [["SEEK-01e", brokenSeek], ["ID-01e", brokenId]] as const) {
  test(`${id}: correct engine passes and wrong engine fails`, async () => {
    expect((await runCase(id, engine, cases[id])).result).toBe("pass");
    expect((await runCase(id, broken, cases[id])).result).toBe("fail");
  });
}

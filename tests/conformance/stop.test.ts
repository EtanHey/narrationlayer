import { test, expect } from "bun:test";
import engine from "../../src/engine/conformance/engine-binding";
import { cases, runCase } from "../../src/engine/conformance/runner";
import { conforming } from "./conforming-engines";
for (const id of ["STOP-01e", "PREEMPT-01e"]) {
  test(`${id}: correct engine`, async () => { expect((await runCase(id, engine, cases[id])).result).toBe("pass"); });
  for (const mode of ["timer", "two", "eight", "serial", "abort", "events"])
    test(`${id}: conforming ${mode}`, async () => { expect((await runCase(id, conforming(mode), cases[id])).result).toBe("pass"); });
}
for (const [name, id] of [["stop", "STOP-01e"], ["preempt", "PREEMPT-01e"]])
  test(`${id}: committed wrong engine`, async () => {
    const broken = (await import(`../../src/engine/conformance/broken-${name}-01`)).default;
    expect((await runCase(id, broken, cases[id])).result).toBe("fail");
  });

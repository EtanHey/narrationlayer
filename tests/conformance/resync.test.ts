import { test, expect } from "bun:test";
import engine from "../../src/engine/conformance/engine-binding";
import { cases, runCase } from "../../src/engine/conformance/runner";
import { conforming } from "./conforming-engines";
import { slowSeek } from "./seek-conforming-engines";
import { wrongResync } from "../../src/engine/conformance/resync-variants";
for (const id of ["SNAP-01", "SEQ-01", "STALE-01"]) {
  for (const binding of [engine, ...["timer", "two", "eight", "serial", "abort", "events"].map(conforming), slowSeek(3), slowSeek(20)])
    test(`${id}: conforming ${binding.name}`, async () => { expect((await runCase(id, binding, cases[id])).result).toBe("pass"); });
}
for (const [fault, id] of [["snap", "SNAP-01"], ["seq", "SEQ-01"], ["stale", "STALE-01"], ["phase", "SNAP-01"], ["count", "SNAP-01"], ["last", "SNAP-01"], ["words", "SNAP-01"], ["plan", "SNAP-01"], ["double", "SNAP-01"]] as const)
  test(`${id}: wrong ${fault} caught`, async () => { expect((await runCase(id, wrongResync(fault), cases[id])).result).toBe("fail"); });

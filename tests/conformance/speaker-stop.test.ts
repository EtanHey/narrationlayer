import { expect, test } from "bun:test";
import engine from "../../src/engine/conformance/engine-binding";
import broken from "../../src/engine/conformance/broken-spk-05e";
import fresh from "../../src/engine/conformance/broken-spk-fresh-attempt";
import { cases, runCase } from "../../src/engine/conformance/runner";
import { conforming } from "./conforming-engines";
for (const binding of [engine, ...["timer", "two", "eight", "serial", "abort", "events"].map(conforming)])
  test(`SPK-05e accepts ${binding.name}`, async () => { expect((await runCase("SPK-05e", binding, cases["SPK-05e"])).result).toBe("pass"); });
test("SPK-05e catches revival after stopping via a delivered read", async () => { expect((await runCase("SPK-05e", broken, cases["SPK-05e"])).result).toBe("fail"); });
test("SPK-05e catches a late result with a fresh attempt id in a stopped session", async () => { expect((await runCase("SPK-05e", fresh, cases["SPK-05e"])).result).toBe("fail"); });

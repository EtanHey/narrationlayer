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

for (const name of ["broken-seek-reject-moves", "broken-seek-stale-taken", "broken-seek-ended-accepted"]) {
  test(`${name}: SEEK-01e rejects the missed behavior`, async () => {
    const broken = (await import(`../../src/engine/conformance/${name}`)).default;
    expect((await runCase("SEEK-01e", broken, cases["SEEK-01e"])).result).toBe("fail");
  });
}

for (const delay of [3, 20] as const) {
  test(`seek delayed ${delay} ms: both seek rows accept a conforming engine`, async () => {
    const { slowSeek } = await import("./seek-conforming-engines");
    for (const id of ["SEEK-01e", "ID-01e"])
      expect((await runCase(id, slowSeek(delay), cases[id])).result).toBe("pass");
  });
}

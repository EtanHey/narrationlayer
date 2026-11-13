import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CaseContext, canonical, cases, registry, runCase, runConformance, validateRegistry } from "../../src/engine/conformance/runner.js";
import { FakeClock } from "../../src/engine/conformance/clock.js";
import binding from "../../src/engine/conformance/null-binding.js";
import broken from "../../src/engine/conformance/broken-binding.js";
import failSet from "../../src/engine/conformance/broken-binding.fail-set.json";

test("fake clock orders ties, cancellation, nested work and microtasks without wall time", async () => {
  const clock = new FakeClock(), seen: number[] = [];
  clock.schedule(5, () => { seen.push(clock.now()); clock.schedule(0, () => seen.push(7)); });
  clock.schedule(5, () => seen.push(6));
  clock.schedule(1, () => seen.push(-1))();
  await clock.advance(4); expect(seen).toEqual([]);
  await clock.advance(1); expect(seen).toEqual([5, 6, 7]); expect(clock.monotonic()).toBe(5);
  expect(() => clock.schedule(-1, () => {})).toThrow(); await expect(clock.advance(-1)).rejects.toThrow();
});
test("signed registry partition, ownership and append-only activation", () => {
  expect(() => validateRegistry(registry)).not.toThrow();
  expect(registry.filter(r => r.stage === "A" && r.side === "engine")).toHaveLength(62);
  expect(registry.filter(r => r.stage === "A" && ["host", "joint"].includes(r.side))).toHaveLength(42);
  expect(registry.filter(r => r.side === "host_supplied")).toHaveLength(2);
  expect(registry.filter(r => r.stage === "B")).toHaveLength(18);
  expect(() => validateRegistry(registry.map(r => r.id === "CONF-01" ? { ...r, active: false } : r))).toThrow();
  expect(() => validateRegistry(registry.map(r => ({ ...r, owner_slice: null })))).toThrow();
  expect(() => validateRegistry(registry.map(r => ({ ...r, owner_slice: "unknown" })))).toThrow();
});
test("report schema and complete denominator pinned; reversed order identical", async () => {
  const report = await runConformance(binding);
  expect(canonical(report)).toBe(readFileSync(new URL("./report.snapshot.json", import.meta.url), "utf8"));
  expect(canonical(await runConformance(binding, { reverse: true }))).toBe(canonical(report));
  expect(report.rows.filter(r => r.result === "pass").map(r => r.id)).toEqual(["CONF-01", "CONF-02"]);
  expect(report.inactive_engine).toBe(60);
});
test("missing case, early stream end and zero assertions are red", async () => {
  expect((await runCase("probe", binding)).result).toBe("fail");
  expect((await runCase("probe", binding, async () => {})).result).toBe("fail");
  const eventProbe = async (c: CaseContext) => { await c.expectEvent(c.binding.create({ clock: c.clock }).events[Symbol.asyncIterator]()); };
  expect((await runCase("probe", binding, eventProbe)).result).toBe("fail");
  const ended = { name: "early", create: () => ({ send() {}, events: (async function* () { yield { type: "first" }; })(), async shutdown() {} }) };
  expect((await runCase("probe", ended, async c => { const stream = c.binding.create({ clock: c.clock }).events[Symbol.asyncIterator](); await c.expectEvent(stream); await c.expectEvent(stream); })).result).toBe("fail");
  expect((await runCase("probe", binding, async c => { try { c.assert(false); } catch {} })).result).toBe("fail");
  const rows = registry.map(r => r.id === "NEG-01" ? { ...r, active: true } : r);
  expect((await runConformance(binding, { rows })).rows.find(r => r.id === "NEG-01")?.result).toBe("fail");
});
test("wall waits and duration reads fail, including swallowed violations; restoration works", async () => {
  for (const forbidden of [() => setTimeout(() => {}, 0), () => Date.now(), () => new Date(), () => performance.now(), () => Bun.sleep(0)]) {
    expect((await runCase("probe", binding, async c => { try { forbidden(); } catch {} c.assert(true); })).result).toBe("fail");
  }
  expect((await runCase("CONF-02", binding, cases["CONF-02"])).result).toBe("pass");
});
test("nondeterministic binding fails exactly its reviewed fail-set", async () => {
  const report = await runConformance(broken);
  expect(report.rows.filter(r => r.result === "fail").map(r => r.id)).toEqual(failSet);
});

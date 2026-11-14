import { expect, test } from "bun:test";
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
  // The supported entry owns the green snapshot; direct imports fail closed.
  expect(canonical(await runConformance(binding, { reverse: true }))).toBe(canonical(report));
  expect(report.rows.filter(r => r.result === "pass").map(r => r.id)).toEqual(["CONF-02"]);
  expect(report.inactive_engine).toBe(31);
});
test("missing case, early stream end and zero assertions are red", async () => {
  expect((await runCase("probe", binding)).result).toBe("fail");
  expect((await runCase("probe", binding, async () => {})).result).toBe("fail");
  const eventProbe = async (c: CaseContext) => { await c.expectEvent(c.binding.create({ clock: c.clock, hash_key: new Uint8Array(32), store: new Map(), audible: false }).events[Symbol.asyncIterator]()); };
  expect((await runCase("probe", binding, eventProbe)).result).toBe("fail");
  const ended = { name: "early", create: () => ({ send() {}, events: (async function* () { yield { type: "first" }; })(), async shutdown() {} }) };
  expect((await runCase("probe", ended, async c => { const stream = c.binding.create({ clock: c.clock, hash_key: new Uint8Array(32), store: new Map(), audible: false }).events[Symbol.asyncIterator](); await c.expectEvent(stream); await c.expectEvent(stream); })).result).toBe("fail");
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
  expect(report.rows.filter(r => r.result === "fail").map(r => r.id)).toEqual([...failSet, "CONF-03", "CONF-04"].sort());
});
test("only literal true assertions pass at runtime; implementation typos fail validation", async () => {
  for (const value of [1, "yes", Promise.resolve(false)]) {
    expect((await runCase("probe", binding, async c => { Reflect.apply(c.assert, c, [value]); })).result).toBe("fail");
  }
  expect(() => validateRegistry(registry, undefined, { ...cases, "CONF-O3": async c => c.assert(true) })).toThrow("unregistered");
});
test("wall timers in binding streams are charged to CONF-02", async () => {
  const timed = { name: "timer", create: () => ({ send() {}, events: (async function* () { await new Promise(resolve => setTimeout(resolve, 0)); yield { type: "welcome" }; })(), async shutdown() {} }) };
  expect((await runConformance(timed)).rows.find(r => r.id === "CONF-02")?.result).toBe("fail");
});
test("observation digests expose fixture differences even when verdicts match", async () => {
  const stamped = (stamp: string) => ({ name: "same-name", create: () => ({ send() {}, events: (async function* () { yield { stamp }; })(), async shutdown() {} }) });
  const first = await runConformance(stamped("process-one")), second = await runConformance(stamped("process-two"));
  expect(first.rows.map(r => r.result)).toEqual(second.rows.map(r => r.result));
  const a = first.rows.find(r => r.id === "CONF-01"), b = second.rows.find(r => r.id === "CONF-01");
  expect(a && "trace_digest" in a ? a.trace_digest : undefined).not.toBe(b && "trace_digest" in b ? b.trace_digest : undefined);
});

test("a hung shutdown or stream makes the harness probe fail by name under fake time", async () => {
  for (const mode of ["shutdown", "stream"]) {
    const hung = { name: mode, create() { return {
      send() {},
      events: (async function* () { if (mode === "stream") await new Promise<void>(() => {}); })(),
      shutdown: () => mode === "shutdown" ? new Promise<void>(() => {}) : Promise.resolve(),
    }; } };
    const report = await runConformance(hung);
    expect(report.rows.find(r => r.id === "CONF-01")?.result).toBe("fail");
    expect(report.rows.every(r => !("diagnostic" in r) || !r.diagnostic?.includes("unavailable"))).toBe(true);
  }
});

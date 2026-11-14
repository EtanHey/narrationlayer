import type { Containment } from "./sandbox.js";
import { createHmac } from "node:crypto";
import registryData from "./registry.json";
import activeIds from "./active.json";
import type { Binding, Connection, Json } from "./binding.js";
import { FakeClock } from "./clock.js";
import { withoutWallTime, trapState, trapsPresent } from "./wall-guard.js";
import { engineCases, hello } from "./engine-cases";
export type Row = { id: string; contract_case: string; contract_line: number; side: string; stage: string; owner_slice: string | null; active: boolean };
export const registry: readonly Row[] = registryData;
export const slices = ["S0a", "S0b", "S1", "S2", "S3a", "S3b", "S4", "S5", "S6", "S6h", "S5h", "S4h", "S7", "S7h", "S8", "S9", "S10a", "S10b"];
export function validateRegistry(rows: readonly Row[], listed = activeIds, implementations = cases): void {
  if (Object.keys(implementations).some(id => !rows.some(r => r.id === id))) throw new Error("unregistered case implementation");
  if (new Set(rows.map(r => r.id)).size !== rows.length || !rows.length) throw new Error("invalid registry ids");
  if (rows.some(r => r.stage === "A" && (!r.owner_slice || !slices.includes(r.owner_slice)))) throw new Error("invalid registry owner");
  if (listed.some(id => !rows.some(r => r.id === id && r.active)) || rows.some(r => r.active && !listed.includes(r.id))) throw new Error("activation list mismatch");
}
export const canonical = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v) + "\n";
export class CaseContext {
  assertions = 0;
  failed = false;
  readonly clock = new FakeClock();
  readonly trace: Json[] = [];
  readonly binding: Binding;
  constructor(binding: Binding) {
    this.binding = { name: binding.name, create: host => {
      const connection = binding.create(host), trace = this.trace;
      return { ...(connection.resolve ? { resolve: (handle: string, lease_id: string) => connection.resolve!(handle, lease_id) } : {}), send: message => connection.send(message), shutdown: deadline => connection.shutdown(deadline),
        events: (async function* () { for await (const event of connection.events) { trace.push(structuredClone(event)); yield event; } })() };
    } };
  }
  assert(ok: boolean): void { this.assertions++; if (ok !== true) { this.failed = true; throw new Error("assertion failed"); } }
  async expectEvent(stream: AsyncIterator<Json>): Promise<Json> {
    const next = await stream.next();
    this.assert(!next.done);
    if (next.done) throw new Error("early stream end");
    return next.value;
  }
}
export type Case = (context: CaseContext) => Promise<void>;
async function execute(id: string, binding: Binding, run?: Case) {
  const context = new CaseContext(binding);
  let wall_violations = 0;
  const start = trapState.violations.length;
  let result: "pass" | "fail" = "pass", probeTimedOut = false;
  try { if (!run) throw new Error("missing implementation"); await withoutWallTime(() => run(context), violated => { wall_violations += Number(violated); }); if (!context.assertions || context.failed) throw new Error("invalid assertions"); }
  catch (error) { result = "fail"; probeTimedOut = error instanceof Error && error.message === "probe did not settle under fake clock"; }
  const realms = trapState.violations.slice(start).filter(v => v.kind === "realm");
  if (realms.length) result = "fail";
  const diagnostic = realms.length ? { diagnostic: `forbidden APIs: ${[...new Set(realms.map(v => v.api))].sort().join(", ")}` } : probeTimedOut ? { diagnostic: "probe did not settle under fake clock" } : {};
  return { outcome: { id, result, assertions: context.assertions, ...diagnostic }, trace: context.trace, wall_violations };
}
export async function runCase(id: string, binding: Binding, run?: Case) {
  const observation = await execute(id, binding, run);
  return { ...observation.outcome, trace_digest: createHmac("sha256", "nl.conformance/1 public synthetic fixture key").update(canonical(observation)).digest("hex") };
}
async function probe(binding: Binding) {
  const clock = new FakeClock();
  const connection: Connection = binding.create({ clock, hash_key: new Uint8Array(32).fill(1), audible: false, store: new Map<string, Uint8Array>() });
  const events: Json[] = [];
  const collect = (async () => { for await (const event of connection.events) events.push(event); })();
  connection.send(hello);
  await clock.advance(0);
  const bounded = async (promise: Promise<unknown>) => {
    let done = false, error: unknown;
    void promise.then(() => { done = true; }, e => { error = e; done = true; });
    for (let i = 0; i < 8 && !done; i++) {
      await clock.advance(1);
      for (let j = 0; j < 128; j++) await Promise.resolve();
    }
    if (!done) throw new Error("probe did not settle under fake clock");
    if (error) throw error;
  };
  await bounded(connection.shutdown(clock.now()));
  await bounded(collect);
  return canonical({ binding: binding.name, events });
}
export const cases: Record<string, Case> = {
  ...engineCases,
  "CONF-01": async c => { c.assert(await probe(c.binding) === await probe(c.binding)); },
  // CONF-03/04: no trapped network (or spawn) call during any active case,
  // and nothing arrived at the parent listener; see README platform limits.
  "CONF-03": async c => { c.assert(trapsPresent() && !trapState.failures.length); },
  "CONF-04": async c => { c.assert(trapsPresent() && !trapState.failures.length); },
  "CONF-02": async c => {
    await probe(c.binding);
    let fired = false;
    c.clock.schedule(1000, () => { fired = true; });
    await c.clock.advance(999); c.assert(!fired);
    await c.clock.advance(1); c.assert(fired && c.clock.monotonic() === 1000);
  },
};
export async function runConformance(binding: Binding, options: { reverse?: boolean; rows?: readonly Row[]; implementations?: Record<string, Case> } = {}) {
  const rows = options.rows ?? registry;
  const implementations = { ...(options.implementations ?? cases) };
  const order = [...rows]; if (options.reverse) order.reverse();
  const results = [];
  for (const row of order) {
    const outcome = row.active ? await runCase(row.id, binding, implementations[row.id]) : { id: row.id, result: "inactive", assertions: 0 };
    results.push({ ...outcome, active: row.active, owner_slice: row.owner_slice, side: row.side, stage: row.stage });
  }
  // Reconcile process-wide violations after every active case, independent of case order.
  for (const result of results) {
    const kind = result.id === "CONF-02" ? "clock" : result.id === "CONF-03" ? "network" : result.id === "CONF-04" ? "spawn" : null;
    const missingTraps = !trapsPresent();
    const failures = trapState.failures.slice().sort();
    const apis = [...new Set(trapState.violations.filter(v => v.kind === kind).map(v => v.api))].sort();
    const needsTraps = kind !== "clock" && (missingTraps || failures.length);
    if (result.result !== "inactive" && kind && (apis.length || needsTraps)) {
      result.result = "fail";
      let diagnostic = `forbidden APIs: ${apis.join(", ")}`;
      if (missingTraps) diagnostic = "traps absent: use the packaged entry";
      else if (failures.length) diagnostic = `trap installation incomplete: ${failures.join(", ")}`;
      Object.assign(result, { diagnostic });
    }
    // Only the parent entry can establish the two-process property.
    if (result.id === "CONF-01") {
      if (result.result === "pass") Object.assign(result, { diagnostic: "two-process comparison required" });
      result.result = "fail";
    }
  }
  return { schema: "nl.conformance/1", containment: "in-process-tripwire" as Containment, binding: binding.name, registry_count: rows.length, inactive: rows.filter(r => !r.active).length,
    inactive_engine: rows.filter(r => !r.active && r.stage === "A" && r.side === "engine").length, rows: results.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}

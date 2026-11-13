import registryData from "./registry.json";
import activeIds from "./active.json";
import type { Binding, Connection, Json } from "./binding.js";
import { FakeClock } from "./clock.js";
import { withoutWallTime } from "./wall-guard.js";
export type Row = { id: string; contract_case: string; contract_line: number; side: string; stage: string; owner_slice: string | null; active: boolean };
export const registry: readonly Row[] = registryData;
export const slices = ["S0a", "S0b", "S1", "S2", "S3a", "S3b", "S4", "S5", "S6", "S6h", "S5h", "S4h", "S7", "S7h", "S8", "S9", "S10a", "S10b"];
export function validateRegistry(rows: readonly Row[], listed = activeIds): void {
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
      return { send: message => connection.send(message), shutdown: deadline => connection.shutdown(deadline),
        events: (async function* () { for await (const event of connection.events) { trace.push(event); yield event; } })() };
    } };
  }
  assert(ok: boolean): void { this.assertions++; if (!ok) { this.failed = true; throw new Error("assertion failed"); } }
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
  let result: "pass" | "fail" = "pass";
  try { if (!run) throw new Error("missing implementation"); await withoutWallTime(() => run(context)); if (!context.assertions || context.failed) throw new Error("invalid assertions"); }
  catch { result = "fail"; }
  return { outcome: { id, result, assertions: context.assertions }, trace: context.trace };
}
export async function runCase(id: string, binding: Binding, run?: Case) { return (await execute(id, binding, run)).outcome; }
async function probe(binding: Binding) {
  const clock = new FakeClock();
  const connection: Connection = binding.create({ clock });
  const events: Json[] = [];
  const collect = (async () => { for await (const event of connection.events) events.push(event); })();
  connection.send({ protocol: "nl.engine/1", type: "hello", version: { major: 1, minor: 0 }, required_caps: [] });
  await clock.advance(0);
  await connection.shutdown(clock.now());
  await collect;
  return canonical({ binding: binding.name, events });
}
export const cases: Record<string, Case> = {
  "CONF-01": async c => { c.assert(await probe(c.binding) === await probe(c.binding)); },
  "CONF-02": async c => {
    let fired = false;
    c.clock.schedule(1000, () => { fired = true; });
    await c.clock.advance(999); c.assert(!fired);
    await c.clock.advance(1); c.assert(fired && c.clock.monotonic() === 1000);
  },
};
export async function runConformance(binding: Binding, options: { reverse?: boolean; rows?: readonly Row[]; implementations?: Record<string, Case> } = {}) {
  const rows = options.rows ?? registry;
  const implementations = { ...(options.implementations ?? cases) };
  if (!options.implementations) implementations["CONF-01"] = async c => {
    const audit = async () => {
      const observations = [];
      for (const row of rows.filter(r => r.active && r.id !== "CONF-01")) observations.push(await execute(row.id, binding, implementations[row.id]));
      return canonical({ probe: await probe(binding), observations });
    };
    c.assert(await audit() === await audit());
  };
  const order = [...rows]; if (options.reverse) order.reverse();
  const results = [];
  for (const row of order) {
    const outcome = row.active ? await runCase(row.id, binding, implementations[row.id]) : { id: row.id, result: "inactive", assertions: 0 };
    results.push({ ...outcome, owner_slice: row.owner_slice });
  }
  return { schema: "nl.conformance/1", binding: binding.name, registry_count: rows.length, inactive: rows.filter(r => !r.active).length,
    inactive_engine: rows.filter(r => !r.active && r.stage === "A" && r.side === "engine").length, rows: results.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}

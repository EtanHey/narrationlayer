// LOCAL ADAPTER EVIDENCE, NOT LAKEBED PROOF. Test-only; never imported by the capsule.
// Models only the documented subset store.ts uses: withIndex(eq/gt prefix)/take/insert/update,
// writes serialized one at a time, and a throwing handler rolls back (snapshot/restore).
import type { Db, Range, Row, Table } from "./capsule/server/store";

type Name = keyof Db;
type Clause = { op: "eq" | "gt"; field: string; value: unknown };
const tables: Name[] = ["memberships", "heads", "events", "quota"];
const unmodeled = (): never => { throw new Error("range operator not modeled by this adapter"); };

export function memoryDb(schema: Record<Name, { indexes: { name: string; fields: string[] }[] }>) {
  let state = { next: 0, rows: Object.fromEntries(tables.map(t => [t, [] as Row[]])) as Record<Name, Row[]> };
  const table = (name: Name): Table => ({
    withIndex(index, range) {
      const fields = schema[name].indexes.find(i => i.name === index)?.fields;
      if (!fields) throw new Error(`unknown index ${name}.${index}`);
      const clauses: Clause[] = [];
      const q: Range = { eq(field, value) { clauses.push({ op: "eq", field, value }); return q; },
        gt(field, value) { clauses.push({ op: "gt", field, value }); return q; },
        gte: unmodeled, lt: unmodeled, lte: unmodeled };
      range(q);
      clauses.forEach((c, i) => {
        if (c.field !== fields[i] || (c.op === "gt" && i !== clauses.length - 1)) throw new Error("range must follow index");
      });
      const key = (r: Row) => fields.map(f => r[f] as string | number);
      return { async take(n) {
        return state.rows[name]
          .filter(r => clauses.every(c => c.op === "eq" ? r[c.field] === c.value : (r[c.field] as number) > (c.value as number)))
          .sort((a, b) => { const x = key(a), y = key(b); const i = x.findIndex((v, j) => v !== y[j]); return i < 0 ? 0 : x[i] < y[i] ? -1 : 1; })
          .slice(0, n).map(r => ({ ...r }));
      } };
    },
    async insert(value) {
      const row = { ...value, id: `${name}-${++state.next}` };
      state.rows[name].push(row);
      return { ...row };
    },
    async update(id, patch) {
      const row = state.rows[name].find(r => r.id === id);
      return row ? { ...Object.assign(row, patch) } : null;
    },
  });
  const db = Object.fromEntries(tables.map(t => [t, table(t)])) as Db;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    dump: () => JSON.stringify(state),
    rows: (name: Name) => state.rows[name].map(r => ({ ...r })),
    run<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      const result = queue.then(async () => {
        const snapshot = structuredClone(state);
        try { return await fn(db); } catch (error) { state = snapshot; throw error; }
      });
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

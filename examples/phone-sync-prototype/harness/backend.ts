import { useEffect, useState } from "preact/hooks";
import type { FieldHead, Port } from "../capsule/client/sync";
import * as reads from "../capsule/server/reads";
import { schema } from "../capsule/server/schema";
import * as store from "../capsule/server/store";
import { FIXTURE } from "../capsule/shared/protocol";
import { memoryDb } from "../memory-db";

// LOCAL HARNESS: not signed-in Lakebed. Accounts are injected strings and store.ts/reads.ts run over
// memory-db (local adapter evidence). Never imported by capsule/; no auth bypass exists there.
export type Harness = ReturnType<typeof createHarness>;
export function createHarness() {
  const mem = memoryDb(schema), listeners = new Set<() => void>();
  for (const account of ["alice", "bob"]) void mem.run(db => store.enroll(db, account));
  const h = {
    calls: [] as Record<string, unknown>[], latency: 0,
    heads: (account: string) => mem.run(db => reads.heads(db, account, FIXTURE.dashboardId)) as unknown as Promise<FieldHead[]>,
    subscribe(listener: () => void) { listeners.add(listener); return () => void listeners.delete(listener); },
    notify: () => listeners.forEach(listener => listener()),
    mutate: (write: typeof store.save, account: string) => async (op: object) => {
      h.calls.push(op as Record<string, unknown>);
      await new Promise(r => setTimeout(r, h.latency));
      const receipt = await mem.run(db => write(db, account, op));
      h.notify();
      return receipt;
    },
  };
  return h;
}

function useVersion(h: Harness) {
  const [version, setVersion] = useState(0);
  useEffect(() => h.subscribe(() => setVersion(v => v + 1)), [h]);
  return version;
}
export function useHarnessPort(h: Harness, account: string): Port {
  const version = useVersion(h), [heads, setHeads] = useState<FieldHead[]>();
  useEffect(() => { void h.heads(account).then(setHeads); }, [h, account, version]);
  return { account, heads, save: h.mutate(store.save, account) };
}

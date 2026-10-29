import { useEffect, useState } from "preact/hooks";
import type { FieldHead, Port, Receipt } from "../capsule/client/sync";
import * as reads from "../capsule/server/reads";
import { schema } from "../capsule/server/schema";
import * as store from "../capsule/server/store";
import { FIXTURE, LIMITS } from "../capsule/shared/protocol";
import { memoryDb } from "../memory-db";

// LOCAL HARNESS: not signed-in Lakebed. Accounts are injected strings and store.ts/reads.ts run over
// memory-db (local adapter evidence). Never imported by capsule/; no auth bypass exists there.
export type Harness = ReturnType<typeof createHarness>;
export function createHarness() {
  const mem = memoryDb(schema), listeners = new Set<() => void>();
  for (const account of ["alice", "bob"]) void mem.run(db => store.enroll(db, account));
  let other = 0;
  const h = {
    calls: [] as Record<string, unknown>[], dropAcks: false, failNext: false, latency: 0,
    heads: (account: string) => mem.run(db => reads.heads(db, account, FIXTURE.dashboardId)) as unknown as Promise<FieldHead[]>,
    receipt: (account: string, deviceId: string, opId: string) =>
      mem.run(db => reads.receipt(db, account, FIXTURE.dashboardId, deviceId, opId)),
    subscribe(listener: () => void) { listeners.add(listener); return () => void listeners.delete(listener); },
    notify: () => listeners.forEach(listener => listener()),
    // Lost acknowledgement: the write commits, the reply is dropped, and receipt reads stay pending.
    setDropAcks(on: boolean) { h.dropAcks = on; h.notify(); },
    mutate: (write: typeof store.save, account: string) => async (op: object) => {
      h.calls.push(op as Record<string, unknown>);
      // Lost request: refused before it reaches the store, so no receipt will ever exist for it.
      if (h.failNext && !(h.failNext = false)) throw new Error("LOCAL HARNESS lost the request before commit");
      await new Promise(r => setTimeout(r, h.latency));
      const receipt = await mem.run(db => write(db, account, op));
      h.notify();
      if (h.dropAcks) throw new Error("LOCAL HARNESS dropped the acknowledgement after commit");
      return receipt;
    },
    // Another device on the same account saves at the current head, so it is accepted.
    async otherDevice(account: string, questionId: string, field: string, payload: string) {
      const head = (await h.heads(account)).find(x => x.questionId === questionId && x.field === field);
      await mem.run(db => store.save(db, account, { protocolVersion: 2, contentRevision: FIXTURE.contentRevision,
        dashboardId: FIXTURE.dashboardId, questionId, field, deviceId: "harness-other-device", opId: `other-${++other}`,
        kind: "save", baseRevision: head?.revision ?? 0, payload, parents: [] }));
      h.notify();
    },
    // Moves the deployment counter to the 48-event save limit without writing events.
    async fillCapacity() {
      await mem.run(db => db.quota.update(mem.rows("quota")[0]!.id, { eventsTotal: LIMITS.SAVE_EVENT_LIMIT }));
      h.notify();
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
  return { account, heads, save: h.mutate(store.save, account), resolve: h.mutate(store.resolve, account),
    useReceipt(deviceId, opId) {
      const version = useVersion(h), [receipt, setReceipt] = useState<Receipt | null>();
      useEffect(() => { if (!h.dropAcks) void h.receipt(account, deviceId, opId).then(setReceipt); }, [version]);
      return receipt;
    } };
}

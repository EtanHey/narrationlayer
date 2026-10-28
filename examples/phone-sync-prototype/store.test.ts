import { expect, test } from "bun:test";
import { schema } from "./capsule/server/schema";
import * as store from "./capsule/server/store";
import { memoryDb } from "./memory-db";
import { FIXTURE, normalize } from "./capsule/shared/protocol";

// LOCAL ADAPTER EVIDENCE ONLY: identities are injected here, outside capsule imports/exports.
// Not Lakebed auth, atomicity or serialization proof; signed-in runtime cases stay UNRUN until P3.
type Mem = ReturnType<typeof memoryDb>;
const U1 = "user-1", U2 = "user-2";
const op = (patch: Record<string, unknown> = {}) => ({ protocolVersion: 2, contentRevision: FIXTURE.contentRevision,
  dashboardId: FIXTURE.dashboardId, questionId: "q-orbit-r1", field: "answer", deviceId: "phone-a", opId: "op-1",
  kind: "save", baseRevision: 0, payload: "Invented", parents: [], ...patch });
const save = (mem: Mem, user: string, patch = {}) => mem.run(db => store.save(db, user, op(patch)));
const resolve = (mem: Mem, user: string, patch = {}) => mem.run(db => store.resolve(db, user, op({ kind: "resolve", ...patch })));
const quota = (mem: Mem) => mem.rows("quota")[0];
async function setup(...users: string[]) {
  const mem = memoryDb(schema);
  for (const user of users) await mem.run(db => store.enroll(db, user));
  return mem;
}
async function refused(mem: Mem, attempt: () => Promise<unknown>, code: string) {
  const before = mem.dump();
  await expect(attempt()).rejects.toThrow(code);
  expect(mem.dump()).toBe(before);
}
// Accepted saves on one field from revision `from` up to `to`; returns the last receipt.
async function fill(mem: Mem, from: number, to: number) {
  let last: { eventId: string } = { eventId: "" };
  for (let r = from; r < to; r++) last = await save(mem, U1, { opId: `fill-${r}`, baseRevision: r, payload: `v${r}` });
  return last;
}

test("T04 enroll is idempotent, never reactivates, refuses a third account", async () => {
  const mem = await setup(U1);
  const before = mem.dump();
  expect(await mem.run(db => store.enroll(db, U1))).toEqual({ enrolled: true });
  expect(mem.dump()).toBe(before);
  await mem.run(db => store.enroll(db, U2));
  await refused(mem, () => mem.run(db => store.enroll(db, "user-3")), "CAPACITY");
  expect(quota(mem)).toMatchObject({ enrolledAccounts: 2, headsTotal: 0, eventsTotal: 0 });
  const revoked = memoryDb(schema);
  await revoked.run(db => db.memberships.insert({ ownerId: U1, dashboardId: FIXTURE.dashboardId, active: false }));
  await refused(revoked, () => revoked.run(db => store.enroll(db, U1)), "DENIED");
  await refused(revoked, () => save(revoked, U1), "DENIED");
  await refused(revoked, () => resolve(revoked, U1), "DENIED");
});

test("T04 save/resolve without membership are denied; scope, kind and identity bounds refuse", async () => {
  const mem = await setup(U1);
  await refused(mem, () => save(mem, U2), "DENIED");
  await refused(mem, () => resolve(mem, U2), "DENIED");
  await refused(mem, () => save(mem, U1, { dashboardId: "d-other" }), "DENIED");
  await refused(mem, () => save(mem, U1, { kind: "resolve" }), "VALIDATION");
  await refused(mem, () => resolve(mem, U1, { kind: "save" }), "VALIDATION");
  await refused(mem, () => save(mem, U1, { questionId: "q-unknown" }), "TARGET");
  await refused(mem, () => mem.run(db => store.enroll(db, "u".repeat(65))), "CAPACITY");
  expect(mem.rows("memberships")).toHaveLength(1);
});

test("T02 replay at the 48 cap after the head advanced 47 times: same receipt, one event; changed fields are OP_ID_REUSE", async () => {
  const mem = await setup(U1);
  const first = await save(mem, U1, { opId: "lost-ack" });
  await fill(mem, 1, 48);
  expect(quota(mem).eventsTotal).toBe(48);
  const before = mem.dump();
  expect(await save(mem, U1, { opId: "lost-ack" })).toEqual(first);
  expect(await save(mem, U1, { opId: "lost-ack" })).toEqual(first);
  expect(mem.dump()).toBe(before);
  expect(mem.rows("events").filter(e => e.opId === "lost-ack")).toHaveLength(1);
  for (const patch of [{ payload: "changed" }, { baseRevision: 5 }, { field: "note" }, { questionId: "q-tide-r1" }]) {
    await refused(mem, () => save(mem, U1, { opId: "lost-ack", ...patch }), "OP_ID_REUSE");
  }
  await refused(mem, () => resolve(mem, U1, { opId: "lost-ack", parents: [first.eventId] }), "OP_ID_REUSE");
});

test("T02 historical op (retired revision/question, seeded) replays before freshness/capacity at the 64 hard cap", async () => {
  const mem = await setup(U1);
  const first = await save(mem, U1);
  const old = { contentRevision: "synthetic-r0", questionId: "q-retired-r0" };
  // Explicitly seeded historical state (an op admitted under a retired registry), not a real migration.
  await mem.run(async db => {
    await db.events.update(first.eventId, { normalizedRequest: normalize(op(old)).json, questionId: old.questionId });
    await db.quota.update(quota(mem).id, { eventsTotal: 64 });
  });
  const forbidden = (): never => { throw new Error("REPLAY_TOUCHED_QUOTA_OR_HEAD"); };
  const sentinel = { withIndex: forbidden, insert: forbidden, update: forbidden };
  const before = mem.dump();
  for (let i = 0; i < 2; i++) {
    expect(await mem.run(db => store.save({ ...db, quota: sentinel, heads: sentinel }, U1, op(old)))).toEqual(first);
  }
  expect(mem.dump()).toBe(before);
  expect(mem.rows("events")).toHaveLength(1);
});

test("receipts carry canonical-at-commit; later writes never alter an earlier event or receipt", async () => {
  const mem = await setup(U1);
  const a = await save(mem, U1);
  const [rowA] = mem.rows("events");
  expect(a).toEqual({ outcome: "accepted", eventId: rowA.id, revision: 1, canonicalEventId: rowA.id });
  const b = await save(mem, U1, { opId: "b" });
  expect(b).toEqual({ outcome: "conflict", eventId: mem.rows("events")[1].id, revision: 2, canonicalEventId: a.eventId });
  const r = await resolve(mem, U1, { opId: "r", baseRevision: 2, parents: [a.eventId, b.eventId] });
  expect(r).toEqual({ outcome: "accepted", eventId: mem.rows("events")[2].id, revision: 3, canonicalEventId: r.eventId });
  const rows = mem.rows("events");
  expect(rows[0]).toEqual(rowA);
  expect(rows.map(e => JSON.parse(e.receipt as string))).toEqual([a, b, r]);
  expect(mem.rows("heads")[0]).toMatchObject({ canonicalEventId: r.eventId, clearedThrough: 3, pendingCount: 0 });
});

test("T03 sequential last ordinary slot 47->48 admits one; overflow is CAPACITY with no change", async () => {
  const mem = await setup(U1);
  await fill(mem, 0, 47);
  expect(await save(mem, U1, { opId: "last", baseRevision: 47 })).toMatchObject({ outcome: "accepted", revision: 48 });
  await refused(mem, () => save(mem, U1, { opId: "over", baseRevision: 48 }), "CAPACITY");
  await refused(mem, () => save(mem, U1, { opId: "t", questionId: "q-unknown" }), "TARGET");
  await refused(mem, () => save(mem, U1, { opId: "c", contentRevision: "older-r0" }), "CONTENT_REVISION");
  expect(quota(mem)).toMatchObject({ eventsTotal: 48, headsTotal: 1 });
});

test("T03 two queued writers at 47 (adapter-serialized, not Lakebed proof) admit exactly one", async () => {
  const mem = await setup(U1);
  await fill(mem, 0, 47);
  const results = await Promise.allSettled([save(mem, U1, { opId: "a", baseRevision: 47 }), save(mem, U1, { opId: "b", baseRevision: 47 })]);
  expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(mem.rows("events")).toHaveLength(48);
  expect(quota(mem).eventsTotal).toBe(48);
});

test("T03 resolutions use the reserved slots up to 63->64, then CAPACITY", async () => {
  const mem = await setup(U1);
  let last = await fill(mem, 0, 48);
  for (let r = 48; r < 63; r++) last = await resolve(mem, U1, { opId: `r-${r}`, baseRevision: r, parents: [last.eventId] });
  expect(await resolve(mem, U1, { opId: "r-63", baseRevision: 63, parents: [last.eventId] }))
    .toMatchObject({ outcome: "accepted", revision: 64 });
  await refused(mem, () => resolve(mem, U1, { opId: "r-64", baseRevision: 64, parents: [] }), "CAPACITY");
  expect(quota(mem).eventsTotal).toBe(64);
});

test("heads <= 8: two accounts fill all fixture heads; a ninth head is CAPACITY", async () => {
  const mem = await setup(U1, U2);
  for (const user of [U1, U2]) for (const questionId of FIXTURE.questionIds) for (const field of ["answer", "note"]) {
    await save(mem, user, { opId: `${questionId}-${field}`, questionId, field });
  }
  expect(quota(mem)).toMatchObject({ headsTotal: 8, eventsTotal: 8 });
  const seeded = await setup(U1);
  await seeded.run(async db => { await db.quota.update(quota(seeded).id, { headsTotal: 8 }); });
  await refused(seeded, () => save(seeded, U1), "CAPACITY");
});

test("pending page is fetched MAX_PENDING+1: a hidden 17th conflict is never resolved", async () => {
  const mem = await setup(U1);
  let s = await save(mem, U1, { opId: "base" });
  const ids = [s.eventId];
  for (let i = 0; i < 16; i++) ids.push((s = await save(mem, U1, { opId: `c-${i}` })).eventId);
  await refused(mem, () => save(mem, U1, { opId: "c-16" }), "CAPACITY");
  await mem.run(async db => { await db.events.insert({ ...mem.rows("events")[1], opId: "hidden", seq: 18 }); });
  await refused(mem, () => resolve(mem, U1, { opId: "r", baseRevision: 17, parents: ids }), "INTEGRITY_ERROR");
});

test("duplicate singleton rows are INTEGRITY_ERROR with no writes", async () => {
  const dupMember = await setup(U1);
  await dupMember.run(async db => { await db.memberships.insert({ ownerId: U1, dashboardId: FIXTURE.dashboardId, active: true }); });
  await refused(dupMember, () => save(dupMember, U1), "INTEGRITY_ERROR");
  const dupQuota = await setup(U1);
  await dupQuota.run(async db => { await db.quota.insert({ key: store.QUOTA_KEY, enrolledAccounts: 0, headsTotal: 0, eventsTotal: 0 }); });
  await refused(dupQuota, () => save(dupQuota, U1), "INTEGRITY_ERROR");
  await refused(dupQuota, () => dupQuota.run(db => store.enroll(db, U2)), "INTEGRITY_ERROR");
  const dupHead = await setup(U1);
  await save(dupHead, U1);
  await dupHead.run(async db => { await db.heads.insert({ ...dupHead.rows("heads")[0] }); });
  await refused(dupHead, () => save(dupHead, U1, { opId: "next", baseRevision: 1 }), "INTEGRITY_ERROR");
  const dupOp = await setup(U1);
  await save(dupOp, U1);
  await dupOp.run(async db => { await db.events.insert({ ...dupOp.rows("events")[0] }); });
  await refused(dupOp, () => save(dupOp, U1), "INTEGRITY_ERROR");
  const badQuota = await setup(U1);
  await badQuota.run(async db => { await db.quota.update(quota(badQuota).id, { eventsTotal: -1 }); });
  await refused(badQuota, () => save(badQuota, U1), "INTEGRITY_ERROR");
});

test("a throw after the event insert rolls back to byte-identical state", async () => {
  const mem = await setup(U1);
  await refused(mem, () => mem.run(db => store.save({ ...db, heads: { ...db.heads,
    insert: () => { throw new Error("INJECTED_FAULT"); } } }, U1, op())), "INJECTED_FAULT");
  expect(await save(mem, U1)).toMatchObject({ outcome: "accepted", revision: 1 });
});

test("stale resolution naming superseded in-scope parents is retained; a foreign parent is denied", async () => {
  const mem = await setup(U1, U2);
  const a = await save(mem, U1), b = await save(mem, U1, { opId: "b" });
  await resolve(mem, U1, { opId: "r1", baseRevision: 2, parents: [a.eventId, b.eventId] });
  expect(await resolve(mem, U1, { opId: "stale", baseRevision: 2, parents: [a.eventId, b.eventId] }))
    .toMatchObject({ outcome: "conflict", revision: 4 });
  const foreign = await save(mem, U2);
  await refused(mem, () => resolve(mem, U1, { opId: "f", baseRevision: 4, parents: [foreign.eventId] }), "DENIED");
});

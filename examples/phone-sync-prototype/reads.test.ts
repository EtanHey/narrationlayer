import { describe, expect, test } from "bun:test";
import { DatabaseSession, MemoryCapsuleStore, serializeSchema } from "lakebed/database";
import { schema } from "./capsule/server/schema";
import * as store from "./capsule/server/store";
import * as reads from "./capsule/server/reads";
import { FIXTURE, LIMITS } from "./capsule/shared/protocol";
import { memoryDb } from "./memory-db";

// LOCAL ADAPTER EVIDENCE: injected accounts, including with Lakebed's real local database.
// Neither backend proves signed-in handlers, hosted transactions or phone behavior.
const D = FIXTURE.dashboardId, Q = FIXTURE.questionIds[0], U1 = "user-1", U2 = "user-2";
const names = ["memberships", "heads", "events", "quota"] as const;
async function setup(backend: string, users = [U1]) {
  const mem = memoryDb(schema), provider = new MemoryCapsuleStore();
  const session = new DatabaseSession({ store: provider, deployId: "p1c-local", cursorSecret: "synthetic-test-only",
    manifest: { apiVersion: 1, indexCodecVersion: 1, schema: serializeSchema(schema), schemaHash: "p1c-schema" } });
  await session.activate();
  const run = <T>(fn: (db: store.Db) => Promise<T>) => backend === "memory" ? mem.run(fn) : session.write(db => fn({
    memberships: db.memberships, heads: db.heads, events: db.events, quota: db.quota,
  })).then(r => r.result);
  const read = <T>(fn: (db: store.ReadDb) => Promise<T>) => backend === "memory" ? mem.run(fn) : session.read(db => fn({
    memberships: db.memberships, heads: db.heads, events: db.events, quota: db.quota,
  }));
  const rows = (name: typeof names[number]) => backend === "memory" ? Promise.resolve(mem.rows(name)) : provider.listRows("p1c-local", name);
  const snapshot = async () => JSON.stringify(await Promise.all(names.map(rows)));
  for (const user of users) await run(db => store.enroll(db, user));
  const op = (patch = {}) => ({ protocolVersion: 2, contentRevision: FIXTURE.contentRevision, dashboardId: D,
    questionId: Q, field: "answer", deviceId: "phone-a", opId: "a", kind: "save", baseRevision: 0,
    payload: "Invented A", parents: [], ...patch });
  return { run, read, rows, snapshot,
    save: (patch = {}, user = U1) => run(db => store.save(db, user, op(patch))),
    resolve: (patch = {}) => run(db => store.resolve(db, U1, op({ kind: "resolve", ...patch }))),
    heads: (user = U1, dashboard: unknown = D) => read(db => reads.heads(db, user, dashboard)),
    history: (user = U1, page: unknown = { cursor: null, numItems: 16 }, field: unknown = "answer") =>
      read(db => reads.history(db, user, D, Q, field, page)),
    receipt: (user = U1, dashboard: unknown = D, device: unknown = "phone-a", id: unknown = "a") =>
      read(db => reads.receipt(db, user, dashboard, device, id)),
  };
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function denied(h: Harness, attempt: () => Promise<unknown>, code = "DENIED") {
  const before = await h.snapshot();
  await expect(attempt()).rejects.toThrow(code);
  expect(await h.snapshot()).toBe(before);
}

describe.each(["memory", "lakebed"])("P1c local adapter evidence: %s", backend => {
  test("T01 resolved history never returns as pending; stale resolution retains all competitors", async () => {
    const h = await setup(backend);
    const a = await h.save(), b = await h.save({ opId: "b", payload: "Invented B" });
    const r = await h.resolve({ opId: "r", baseRevision: 2, parents: [a.eventId, b.eventId], payload: "Chosen AB" });
    expect((await h.heads())[0]).toMatchObject({ pending: [], canonical: { id: r.eventId } });
    const c = await h.save({ opId: "c", payload: "Invented C" });
    const stale = await h.resolve({ opId: "stale", baseRevision: 3, parents: [r.eventId], payload: "Stale choice" });
    expect(stale.outcome).toBe("conflict");
    const [head] = await h.heads();
    expect(head.pending.map(e => e.id)).toEqual([c.eventId, stale.eventId]);
    const final = await h.resolve({ opId: "final", baseRevision: 5,
      parents: [r.eventId, c.eventId, stale.eventId], payload: "Complete choice" });
    expect(final.outcome).toBe("accepted");
    expect((await h.heads())[0]).toMatchObject({ canonical: { id: final.eventId }, pending: [], clearedThrough: 6 });
    expect((await h.history()).page.map(e => e.id)).toEqual([a, b, r, c, stale, final].map(e => e.eventId));
    expect((await h.history()).page[1].payload).toBe("Invented B");
    expect(await h.receipt()).toEqual(a);
  });

  test("T05 answer/note saves survive, and either local serialization of resolve/edit preserves values", async () => {
    for (const editFirst of [false, true]) {
      const h = await setup(backend);
      await Promise.all([h.save(), h.save({ opId: "note", field: "note", payload: "Invented note" })]);
      const heads = await h.heads();
      expect(heads.map(e => [e.field, e.canonical?.payload])).toEqual([["answer", "Invented A"], ["note", "Invented note"]]);
      const a = heads[0].canonical!;
      const edit = () => h.save({ opId: "edit", baseRevision: 1, payload: "Racing edit" });
      const resolve = () => h.resolve({ opId: "resolve", baseRevision: 1, parents: [a.id], payload: "Racing choice" });
      const outcomes = await Promise.all(editFirst ? [edit(), resolve()] : [resolve(), edit()]);
      expect(outcomes.map(e => e.outcome)).toEqual(["accepted", "conflict"]);
      const [current] = await h.heads();
      expect([current.canonical?.payload, ...current.pending.map(e => e.payload)].sort()).toEqual(["Racing choice", "Racing edit"]);
      expect((await h.history()).page.map(e => e.payload)).toContain("Invented A");
      expect((await h.history(U1, { cursor: null, numItems: 16 }, "note")).page.map(e => e.payload)).toEqual(["Invented note"]);
    }
  });

  test("T04 read membership, account scope, independent operation strings and revocation", async () => {
    const h = await setup(backend);
    const a = await h.save();
    for (const attempt of [() => h.heads(U2), () => h.history(U2), () => h.receipt(U2)]) await denied(h, attempt);
    await h.run(db => store.enroll(db, U2));
    expect(await h.heads(U2)).toEqual([]);
    expect((await h.history(U2)).page).toEqual([]);
    expect(await h.receipt(U2)).toBeNull();
    const b = await h.save({ payload: "U2 invented" }, U2);
    expect(b.eventId).not.toBe(a.eventId);
    expect(await h.receipt()).toEqual(a);
    expect(await h.receipt(U2)).toEqual(b);
    expect((await h.heads(U2))[0].canonical?.id).toBe(b.eventId);
    expect((await h.history(U2)).page.map(e => e.id)).toEqual([b.eventId]);
    const member = (await h.rows("memberships")).find(e => e.ownerId === U1)!;
    await h.run(db => db.memberships.update(member.id, { active: false }));
    for (const attempt of [() => h.heads(), () => h.history(), () => h.receipt()]) await denied(h, attempt);
  });

  test("history is bounded, paginated, query-scoped and read-only", async () => {
    const h = await setup(backend, [U1, U2]);
    for (let i = 0; i < 18; i++) await h.save({ opId: `page-${i}`, baseRevision: i });
    const before = await h.snapshot();
    const first = await h.history();
    expect(first.page).toHaveLength(16);
    expect(first.isDone).toBe(false);
    expect(typeof first.continueCursor).toBe("string");
    const next = { cursor: first.continueCursor, numItems: 16 };
    const last = await h.history(U1, next);
    expect(last.isDone).toBe(true);
    expect(last.continueCursor).toBeNull();
    expect([...first.page, ...last.page].map(e => e.seq)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(await h.snapshot()).toBe(before);
    for (const numItems of [0, -1, 17, 1.5, NaN, Infinity, "16"]) {
      await denied(h, () => h.history(U1, { cursor: null, numItems }), "VALIDATION");
    }
    for (const page of [null, {}, { cursor: 1, numItems: 1 }, { cursor: null, numItems: 1, ownerId: U2 }]) {
      await denied(h, () => h.history(U1, page), "VALIDATION");
    }
    await denied(h, () => h.history(U2, next), "cursor");
    await denied(h, () => h.history(U1, next, "note"), "cursor");
  });

  test("receipt is immutable, checks stored dashboard, and validates read arguments", async () => {
    const h = await setup(backend), a = await h.save();
    await h.save({ opId: "later", baseRevision: 1 });
    expect(await h.receipt()).toEqual(a);
    expect(await h.receipt(U1, D, "missing")).toBeNull();
    await denied(h, () => h.receipt(U1, "d-foreign"));
    await denied(h, () => h.heads(U1, "d-foreign"));
    await denied(h, () => h.read(db => reads.history(db, U1, "d-foreign", Q, "answer", { cursor: null, numItems: 1 })));
    await denied(h, () => h.heads("x".repeat(65)), "CAPACITY");
    await denied(h, () => h.receipt(U1, D, ""), "VALIDATION");
    await denied(h, () => h.receipt(U1, D, "phone-a", "x".repeat(65)), "CAPACITY");
    await denied(h, () => h.history(U1, { cursor: null, numItems: 1 }, "bogus"), "VALIDATION");
    await denied(h, () => h.read(db => reads.history(db, U1, D, "unknown", "answer", { cursor: null, numItems: 1 })), "TARGET");
    await h.run(db => db.events.update(a.eventId, { dashboardId: "d-foreign" }));
    await denied(h, () => h.receipt());
  });

  test("foreign parents, head pointers and event scopes are denied without changes", async () => {
    const h = await setup(backend, [U1, U2]);
    const a = await h.save(), foreign = await h.save({}, U2);
    await denied(h, () => h.resolve({ opId: "foreign", baseRevision: 1, parents: [foreign.eventId] }));
    const head = (await h.rows("heads")).find(e => e.ownerId === U1)!;
    await h.run(db => db.heads.update(head.id, { canonicalEventId: foreign.eventId }));
    await denied(h, () => h.heads());
    await h.run(db => db.heads.update(head.id, { canonicalEventId: a.eventId }));
    await h.run(db => db.events.update(a.eventId, { questionId: FIXTURE.questionIds[1] }));
    await denied(h, () => h.heads());
    expect(LIMITS.MAX_PAGE).toBe(16);
  });

  test("empty reads, first-write conflicts, and duplicate or inconsistent evidence", async () => {
    const h = await setup(backend);
    expect(await h.heads()).toEqual([]);
    expect((await h.history()).page).toEqual([]);
    expect(await h.receipt()).toBeNull();
    const a = await h.save({ baseRevision: 1 });
    expect(a.outcome).toBe("conflict");
    expect((await h.heads())[0]).toMatchObject({ canonical: null, pending: [{ id: a.eventId }] });
    const [head] = await h.rows("heads");
    await h.run(db => db.heads.update(head.id, { pendingCount: 0 }));
    await denied(h, () => h.heads(), "INTEGRITY_ERROR");
    await h.run(db => db.heads.update(head.id, { pendingCount: 1 }));
    await h.run(db => db.heads.update(head.id, { revision: 2 }));
    await denied(h, () => h.heads(), "INTEGRITY_ERROR");
    await h.run(db => db.heads.update(head.id, { revision: 1 }));
    const copy = (row: store.Row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["id", "createdAt", "updatedAt"].includes(key)));
    await h.run(db => db.heads.insert(copy({ ...head, pendingCount: 1 })));
    await denied(h, () => h.heads(), "INTEGRITY_ERROR");
    const [event] = await h.rows("events");
    await h.run(db => db.events.insert(copy(event)));
    await denied(h, () => h.receipt(), "INTEGRITY_ERROR");
    await h.run(db => db.memberships.insert({ ownerId: U1, dashboardId: D, active: true }));
    for (const attempt of [() => h.heads(), () => h.history(), () => h.receipt()]) await denied(h, attempt, "INTEGRITY_ERROR");
  });
});

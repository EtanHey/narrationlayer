import type { IndexRange, PaginationOptions, PaginationResult } from "lakebed/database";
import { FIXTURE, LIMITS, boundedText, decide, normalize, replay, sealReceipt, type Event, type Head, type Scope } from "../shared/protocol";

// Admission logic over a narrow port of the documented database subset: withIndex(eq/gt)/take/paginate,
// insert, update (docs.lakebed.dev/database; lakebed/dist/database/query.d.ts:15-23,79-85,94,96,103,110-111).
// ownerId comes only from ctx.auth.requireSignedIn() in the handler, never from arguments.
export type Row = Record<string, unknown> & { id: string };
export type Range = IndexRange; // store.ts calls only eq and gt
export type ReadTable = {
  withIndex(index: string, range: (q: Range) => Range): {
    take(n: number): Promise<Row[]>;
    paginate(page: PaginationOptions): Promise<PaginationResult<Row>>;
  };
};
export type Table = ReadTable & {
  insert(value: Record<string, unknown>): Promise<Row>;
  update(id: string, patch: Record<string, unknown>): Promise<unknown>;
};
export type Db = Record<"memberships" | "heads" | "events" | "quota", Table>;
export type ReadDb = Record<keyof Db, ReadTable>;
export type Receipt = { outcome: "accepted" | "conflict"; eventId: string; revision: number; canonicalEventId: string | null };
export const QUOTA_KEY = "deployment";
type Counts = { enrolledAccounts: number; headsTotal: number; eventsTotal: number };

function fail(code: string): never { throw new Error(code); }
// Indexes are not unique: two matches is corruption, never a guessed winner.
export async function single(table: ReadTable, index: string, pairs: [string, unknown][]) {
  const rows = await table.withIndex(index, q => pairs.reduce((r, [f, v]) => r.eq(f, v), q)).take(2);
  if (rows.length > 1) fail("INTEGRITY_ERROR");
  return rows[0];
}
async function readQuota(db: Db) {
  const row = await single(db.quota, "by_key", [["key", QUOTA_KEY]]);
  const counts = { enrolledAccounts: row?.enrolledAccounts ?? 0, headsTotal: row?.headsTotal ?? 0, eventsTotal: row?.eventsTotal ?? 0 };
  if (!Object.values(counts).every(n => Number.isSafeInteger(n) && (n as number) >= 0)) fail("INTEGRITY_ERROR");
  return { row, counts: counts as Counts };
}
// The first quota insert and every counter reservation commit in the mutation they admit.
async function writeQuota(db: Db, row: Row | undefined, counts: Counts) {
  if (row) await db.quota.update(row.id, counts);
  else await db.quota.insert({ key: QUOTA_KEY, ...counts });
}
export async function membership(db: ReadDb, ownerId: string) {
  boundedText(ownerId, LIMITS.MAX_ID_UTF8, true); // unsupported identity is refused, never truncated
  return single(db.memberships, "by_owner_dashboard", [["ownerId", ownerId], ["dashboardId", FIXTURE.dashboardId]]);
}

export async function enroll(db: Db, ownerId: string) {
  const existing = await membership(db, ownerId);
  if (existing) {
    if (existing.active !== true) fail("DENIED"); // inactive is never recreated or reactivated
    return { enrolled: true };
  }
  const { row, counts } = await readQuota(db);
  if (counts.enrolledAccounts >= LIMITS.MAX_ACCOUNTS) fail("CAPACITY");
  await db.memberships.insert({ ownerId, dashboardId: FIXTURE.dashboardId, active: true });
  await writeQuota(db, row, { ...counts, enrolledAccounts: counts.enrolledAccounts + 1 });
  return { enrolled: true };
}

export const save = (db: Db, ownerId: string, raw: unknown) => write(db, ownerId, raw, false);
export const resolve = (db: Db, ownerId: string, raw: unknown) => write(db, ownerId, raw, true);

// C2 order: membership -> op lookup -> replay/OP_ID_REUSE -> new-op content/target/capacity ->
// bounded evidence -> decide -> insert event, seal receipt with its own id, advance head and quota.
async function write(db: Db, ownerId: string, raw: unknown, resolution: boolean): Promise<Receipt> {
  if ((await membership(db, ownerId))?.active !== true) fail("DENIED");
  const op = normalize(raw), v = op.value;
  if ((v.kind === "resolve") !== resolution) fail("VALIDATION");
  if (v.dashboardId !== FIXTURE.dashboardId) fail("DENIED");
  const prior = await single(db.events, "by_op", [["ownerId", ownerId], ["deviceId", v.deviceId], ["opId", v.opId]]);
  if (prior) return JSON.parse(replay(prior as unknown as Event, op));

  if (!FIXTURE.questionIds.includes(v.questionId)) fail("TARGET");
  if (v.contentRevision !== FIXTURE.contentRevision) fail("CONTENT_REVISION");
  const { row: quotaRow, counts } = await readQuota(db);
  if (counts.eventsTotal >= (resolution ? LIMITS.MAX_EVENTS : LIMITS.SAVE_EVENT_LIMIT)) fail("CAPACITY");
  const scope: Scope = { ownerId, dashboardId: v.dashboardId, questionId: v.questionId, field: v.field };
  const keys = Object.entries(scope);
  const headRow = await single(db.heads, "by_scope", keys);
  if (!headRow && counts.headsTotal >= LIMITS.MAX_HEADS) fail("CAPACITY");
  const head: Head = headRow ? { revision: headRow.revision as number, clearedThrough: headRow.clearedThrough as number,
    pendingCount: headRow.pendingCount as number,
    ...(headRow.canonicalEventId == null ? {} : { canonicalEventId: headRow.canonicalEventId as string }) }
    : { revision: 0, clearedThrough: 0, pendingCount: 0 };

  const scoped = (range: (q: Range) => Range) =>
    db.events.withIndex("by_field_seq", q => range(keys.reduce((r, [f, x]) => r.eq(f, x), q)));
  // One past the cap, so an over-full frontier is detected and never decided on a truncated page.
  const evidence = await scoped(q => q.gt("seq", head.clearedThrough)).take(LIMITS.MAX_PENDING + 1);
  if (head.clearedThrough > 0) evidence.push(...await scoped(q => q.eq("seq", head.clearedThrough)).take(2));
  // Superseded in-scope parents make a retained conflict; foreign or unknown parents stay absent -> DENIED.
  const missing = v.parents.filter(id => !evidence.some(e => e.id === id));
  if (missing.length) evidence.push(...(await scoped(q => q).take(LIMITS.MAX_EVENTS)).filter(e => missing.includes(e.id)));
  // decide() re-validates scope, seq and id of every evidence row before trusting it.
  const proposal = decide(scope, head, evidence as unknown as Event[], op);

  const event = await db.events.insert({ ...scope, deviceId: v.deviceId, opId: v.opId, seq: proposal.seq,
    normalizedRequest: op.json, receipt: "", outcome: proposal.outcome, payload: v.payload, parents: JSON.stringify(v.parents) });
  const canonicalEventId = proposal.accepted ? event.id : head.canonicalEventId;
  const receipt = sealReceipt({ outcome: proposal.outcome, eventId: event.id, revision: proposal.seq,
    canonicalEventId: canonicalEventId ?? null });
  await db.events.update(event.id, { receipt });
  const next = { revision: proposal.seq, clearedThrough: proposal.accepted ? proposal.seq : head.clearedThrough,
    pendingCount: proposal.accepted ? 0 : head.pendingCount + 1, ...(canonicalEventId ? { canonicalEventId } : {}) };
  if (headRow) await db.heads.update(headRow.id, next);
  else await db.heads.insert({ ...scope, ...next });
  await writeQuota(db, quotaRow, { ...counts, eventsTotal: counts.eventsTotal + 1,
    headsTotal: counts.headsTotal + (headRow ? 0 : 1) });
  return JSON.parse(receipt);
}

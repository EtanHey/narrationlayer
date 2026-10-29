import type { PaginationOptions } from "lakebed/database";
import { FIXTURE, LIMITS, boundedText } from "../shared/protocol";
import { membership, single, type ReadDb, type Row, type Receipt } from "./store";

function fail(code: string): never { throw new Error(code); }
const appId = (value: unknown) => boundedText(value, LIMITS.MAX_ID_UTF8, true);
async function authorize(db: ReadDb, ownerId: string, dashboard: unknown) {
  const member = await membership(db, ownerId);
  if (!member || member.active !== true) fail("DENIED");
  const dashboardId = appId(dashboard);
  if (dashboardId !== FIXTURE.dashboardId) fail("DENIED");
  return dashboardId;
}
function scoped(row: Row, scope: Record<string, unknown>) {
  if (Object.entries(scope).some(([key, value]) => row[key] !== value)) fail("DENIED");
}
function pageOptions(raw: unknown): PaginationOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) fail("VALIDATION");
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 2 || !keys.includes("cursor") || !keys.includes("numItems")) fail("VALIDATION");
  const cursor = Object.getOwnPropertyDescriptor(raw, "cursor");
  const count = Object.getOwnPropertyDescriptor(raw, "numItems");
  if (!cursor || !("value" in cursor) || !count || !("value" in count)) fail("VALIDATION");
  const numItems: unknown = count.value, token: unknown = cursor.value;
  if (typeof numItems !== "number" || !Number.isSafeInteger(numItems) || numItems < 1 || numItems > LIMITS.MAX_PAGE) fail("VALIDATION");
  return { numItems, cursor: token === null ? null : boundedText(token, LIMITS.MAX_NORMALIZED_UTF8, true) };
}

export async function heads(db: ReadDb, ownerId: string, dashboard: unknown): Promise<(Row & { canonical: Row | null; pending: Row[] })[]> {
  const dashboardId = await authorize(db, ownerId, dashboard), scope = { ownerId, dashboardId };
  const rows = await db.heads.withIndex("by_scope", q => q.eq("ownerId", ownerId).eq("dashboardId", dashboardId)).take(LIMITS.MAX_HEADS + 1);
  if (rows.length > LIMITS.MAX_HEADS) fail("INTEGRITY_ERROR");
  const seen = new Set<string>();
  return Promise.all(rows.map(async row => {
    scoped(row, scope);
    const { questionId, field, revision, clearedThrough, pendingCount } = row;
    if (typeof questionId !== "string" || (field !== "answer" && field !== "note")) fail("INTEGRITY_ERROR");
    const key = JSON.stringify([questionId, field]);
    if (seen.has(key)) fail("INTEGRITY_ERROR");
    seen.add(key);
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 ||
        typeof clearedThrough !== "number" || !Number.isSafeInteger(clearedThrough) || clearedThrough < 0 ||
        typeof pendingCount !== "number" || !Number.isSafeInteger(pendingCount) || pendingCount < 0 ||
        pendingCount > LIMITS.MAX_PENDING || revision - clearedThrough !== pendingCount) fail("INTEGRITY_ERROR");
    const fieldScope = { ...scope, questionId, field };
    const pending = await db.events.withIndex("by_field_seq", q => q.eq("ownerId", ownerId).eq("dashboardId", dashboardId)
      .eq("questionId", questionId).eq("field", field).gt("seq", clearedThrough)).take(LIMITS.MAX_PENDING + 1);
    const canonical = clearedThrough === 0 ? null :
      await single(db.events, "by_field_seq", [...Object.entries(fieldScope), ["seq", clearedThrough]]) ?? null;
    if (canonical ? canonical.id !== row.canonicalEventId : clearedThrough !== 0 || row.canonicalEventId !== undefined) fail("DENIED");
    if (canonical) scoped(canonical, fieldScope);
    pending.forEach((event, i) => {
      scoped(event, fieldScope);
      if (event.seq !== clearedThrough + i + 1) fail("INTEGRITY_ERROR");
    });
    if (pending.length !== pendingCount) fail("INTEGRITY_ERROR");
    return { ...row, canonical, pending };
  }));
}

export async function history(db: ReadDb, ownerId: string, dashboard: unknown, question: unknown, field: unknown, page: unknown) {
  const dashboardId = await authorize(db, ownerId, dashboard), questionId = appId(question);
  if (field !== "answer" && field !== "note") fail("VALIDATION");
  if (!FIXTURE.questionIds.includes(questionId)) fail("TARGET");
  const options = pageOptions(page), scope = { ownerId, dashboardId, questionId, field };
  const result = await db.events.withIndex("by_field_seq", q => q.eq("ownerId", ownerId).eq("dashboardId", dashboardId)
    .eq("questionId", questionId).eq("field", field)).paginate(options);
  result.page.forEach(row => scoped(row, scope));
  return result;
}

export async function receipt(db: ReadDb, ownerId: string, dashboard: unknown, device: unknown, operation: unknown): Promise<Receipt | null> {
  const dashboardId = await authorize(db, ownerId, dashboard), deviceId = appId(device), opId = appId(operation);
  const row = await single(db.events, "by_op", [["ownerId", ownerId], ["deviceId", deviceId], ["opId", opId]]);
  if (!row) return null;
  scoped(row, { ownerId, deviceId, opId });
  if (row.dashboardId !== dashboardId) fail("DENIED");
  return JSON.parse(boundedText(row.receipt, LIMITS.MAX_RECEIPT_UTF8, true));
}

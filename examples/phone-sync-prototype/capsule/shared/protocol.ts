// Pure P1 algorithm slice. No public handlers, authentication, storage or transaction claim.
export const FIXTURE = Object.freeze({ dashboardId: "d-demo-r1", contentRevision: "synthetic-r1",
  questionIds: Object.freeze(["q-orbit-r1", "q-tide-r1"]) });
export const LIMITS = Object.freeze({ MAX_ACCOUNTS: 2, DASHBOARDS_PER_ACCOUNT: 1, QUESTIONS: 2,
  FIELDS_PER_QUESTION: 2, MAX_HEADS: 8, MAX_ID_UTF8: 64, MAX_PAYLOAD_UTF8: 2048,
  MAX_NORMALIZED_UTF8: 4096, MAX_RECEIPT_UTF8: 512, MAX_PENDING: 16, MAX_PARENT_IDS: 17,
  MAX_EVENTS: 64, SAVE_EVENT_LIMIT: 48, MAX_PAGE: 16 });
export type Scope = { ownerId: string; dashboardId: string; questionId: string; field: "answer" | "note" };
export type Head = { revision: number; canonicalEventId?: string; clearedThrough: number; pendingCount: number };
export type Event = Scope & { id: string; seq: number; normalizedRequest: string; receipt: string;
  payload: string; parents: string };
type Operation = Omit<Scope, "ownerId"> & { protocolVersion: 2; contentRevision: string; deviceId: string;
  opId: string; kind: "save" | "clear" | "resolve"; baseRevision: number; payload: string; parents: string[] };
declare const brand: unique symbol;
export type Normalized = Readonly<{ value: Readonly<Operation>; json: string; [brand]: true }>;
// N4: only normalize() outputs pass replay/decide; a structural copy is refused at runtime.
const issued = new WeakSet<object>();
function own(op: Normalized): Readonly<Operation> {
  if (!issued.has(op)) fail("VALIDATION");
  return op.value;
}
const keys = ["protocolVersion", "contentRevision", "dashboardId", "questionId", "field", "deviceId",
  "opId", "kind", "baseRevision", "payload", "parents"];
function fail(code: string): never { throw new Error(code); }
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
// Count scalar UTF-8 bytes without depending on a DOM encoder; reject Lakebed-invalid NUL too.
export function boundedText(value: unknown, maxBytes: number, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.length)) fail("VALIDATION");
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0 || (c >= 0xdc00 && c <= 0xdfff)) fail("VALIDATION");
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("VALIDATION");
      bytes += 4;
    } else bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (bytes > maxBytes) fail("CAPACITY");
  }
  return value;
}
const appId = (v: unknown) => boundedText(v, LIMITS.MAX_ID_UTF8, true);
export function normalize(raw: unknown): Normalized {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("VALIDATION");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== null && proto !== Object.prototype) fail("VALIDATION");
  const actual = Reflect.ownKeys(raw);
  if (actual.length !== keys.length || actual.some(k => typeof k !== "string" || !keys.includes(k))) fail("VALIDATION");
  const v: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor)) fail("VALIDATION");
    v[key] = descriptor.value;
  }
  if (v.protocolVersion !== 2 || !integer(v.baseRevision)) fail("VALIDATION");
  if (v.field !== "answer" && v.field !== "note") fail("VALIDATION");
  if (v.kind !== "save" && v.kind !== "clear" && v.kind !== "resolve") fail("VALIDATION");
  const source = v.parents;
  if (!Array.isArray(source) || Object.getPrototypeOf(source) !== Array.prototype) fail("VALIDATION");
  const length = Object.getOwnPropertyDescriptor(source, "length")?.value;
  if (!integer(length) || length > LIMITS.MAX_PARENT_IDS) fail("CAPACITY");
  const dense: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const element = Object.getOwnPropertyDescriptor(source, String(i));
    if (!element) fail("VALIDATION");
    if (!("value" in element)) fail("VALIDATION");
    dense.push(element.value);
  }
  const parents = dense.map(appId).sort();
  if (new Set(parents).size !== parents.length) fail("VALIDATION");
  const payload = boundedText(v.payload, LIMITS.MAX_PAYLOAD_UTF8);
  if ((v.kind !== "resolve" && parents.length) || (v.kind === "clear" && payload !== "")) fail("VALIDATION");
  const value: Operation = { protocolVersion: 2, contentRevision: appId(v.contentRevision),
    dashboardId: appId(v.dashboardId), questionId: appId(v.questionId), field: v.field,
    deviceId: appId(v.deviceId), opId: appId(v.opId), kind: v.kind,
    baseRevision: v.baseRevision, payload, parents };
  const json = boundedText(JSON.stringify(value), LIMITS.MAX_NORMALIZED_UTF8);
  Object.freeze(value.parents);
  const op = Object.freeze({ value: Object.freeze(value), json }) as Normalized;
  issued.add(op);
  return op;
}
// Call only after signed-in identity, active membership, bounded shape and dashboard authorization.
// The future storage adapter must do the account/device/op lookup BEFORE new-operation checks.
export function replay(existing: Pick<Event, "normalizedRequest" | "receipt">, op: Normalized): string {
  own(op);
  if (existing.normalizedRequest !== op.json) fail("OP_ID_REUSE");
  return existing.receipt;
}
export function sealReceipt(value: unknown): string {
  const json = JSON.stringify(value);
  return boundedText(json, LIMITS.MAX_RECEIPT_UTF8, true);
}
function sameScope(a: Scope, b: Scope): boolean {
  return a.ownerId === b.ownerId && a.dashboardId === b.dashboardId &&
    a.questionId === b.questionId && a.field === b.field;
}
// Evidence must contain canonical + ALL pending + supplied parents, with no foreign rows.
// This pure helper cannot prove the adapter fetched a complete page or reserved global quota.
export function decide(scope: Scope, head: Head, evidence: readonly Event[], op: Normalized) {
  const v = own(op);
  appId(scope.ownerId);
  if (scope.dashboardId !== v.dashboardId || scope.questionId !== v.questionId || scope.field !== v.field) fail("DENIED");
  if (v.dashboardId !== FIXTURE.dashboardId || !FIXTURE.questionIds.includes(v.questionId)) fail("TARGET");
  if (v.contentRevision !== FIXTURE.contentRevision) fail("CONTENT_REVISION");
  if (!integer(head.revision) || !integer(head.clearedThrough) || !integer(head.pendingCount) ||
      head.revision < head.clearedThrough || head.pendingCount !== head.revision - head.clearedThrough ||
      head.pendingCount > LIMITS.MAX_PENDING || head.revision >= Number.MAX_SAFE_INTEGER) fail("INTEGRITY_ERROR");
  if (evidence.length > LIMITS.MAX_EVENTS) fail("CAPACITY");
  const byId = new Map<string, Event>();
  const bySeq = new Set<number>();
  for (const event of evidence) {
    appId(event.id);
    if (!sameScope(scope, event)) fail("DENIED");
    if (!integer(event.seq) || event.seq < 1 || event.seq > head.revision ||
        byId.has(event.id) || bySeq.has(event.seq)) fail("INTEGRITY_ERROR");
    byId.set(event.id, event);
    bySeq.add(event.seq);
  }
  const canonical = head.canonicalEventId === undefined ? undefined : byId.get(head.canonicalEventId);
  if ((head.canonicalEventId !== undefined && (!canonical || canonical.seq !== head.clearedThrough)) ||
      (head.canonicalEventId === undefined && head.clearedThrough !== 0)) fail("INTEGRITY_ERROR");
  const pending = evidence.filter(e => e.seq > head.clearedThrough);
  if (pending.length !== head.pendingCount) fail("INTEGRITY_ERROR");
  // Unique seq values in (clearedThrough, revision] plus exact count imply a complete frontier.
  for (const parent of v.parents) if (!byId.has(parent)) fail("DENIED");
  const frontier = [...(canonical ? [canonical.id] : []), ...pending.map(e => e.id)].sort();
  const complete = frontier.length === v.parents.length && frontier.every((id, i) => id === v.parents[i]);
  const accepted = v.baseRevision === head.revision &&
    (v.kind === "resolve" ? complete : head.pendingCount === 0);
  if (!accepted && head.pendingCount >= LIMITS.MAX_PENDING) fail("CAPACITY");
  return Object.freeze({ accepted, outcome: accepted ? "accepted" : "conflict", seq: head.revision + 1 });
}

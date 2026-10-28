import { expect, test } from "bun:test";
import { normalize, decide, replay, sealReceipt, boundedText, FIXTURE, LIMITS, type Event, type Head, type Scope } from "./protocol";

// Local algorithm evidence only: no Lakebed imports, identity injection or transactions.
const scope: Scope = { ownerId: "synthetic-account", dashboardId: FIXTURE.dashboardId, questionId: "q-orbit-r1", field: "answer" };
const empty = (): Head => ({ revision: 0, clearedThrough: 0, pendingCount: 0 });
function input(patch: Record<string, unknown> = {}) {
  return { protocolVersion: 2, contentRevision: FIXTURE.contentRevision, dashboardId: scope.dashboardId,
    questionId: scope.questionId, field: scope.field, deviceId: "phone-a", opId: "op-a", kind: "save",
    baseRevision: 0, payload: "Invented orbit: 7", parents: [], ...patch };
}
function append(head: Head, events: Event[], patch: Record<string, unknown> = {}) {
  const op = normalize(input(patch));
  const proposal = decide(scope, head, events, op);
  const id = `event-${events.length + 1}`;
  const receipt = sealReceipt({ outcome: proposal.outcome, eventId: id, revision: proposal.seq,
    canonicalEventId: proposal.accepted ? id : head.canonicalEventId ?? null });
  const event: Event = { ...scope, id, seq: proposal.seq, normalizedRequest: op.json,
    receipt, payload: op.value.payload, parents: JSON.stringify(op.value.parents) };
  return { head: { revision: proposal.seq, clearedThrough: proposal.accepted ? proposal.seq : head.clearedThrough,
    pendingCount: proposal.accepted ? 0 : head.pendingCount + 1,
    canonicalEventId: proposal.accepted ? id : head.canonicalEventId }, events: [...events, event], receipt };
}

test("local two-client race and clear retain canonical and competitor", () => {
  const a = append(empty(), []);
  const b = append(a.head, a.events, { deviceId: "phone-b", opId: "op-b", kind: "clear", payload: "" });
  expect(b.head).toMatchObject({ revision: 2, canonicalEventId: "event-1", pendingCount: 1 });
  expect(b.events.map(e => e.payload)).toEqual(["Invented orbit: 7", ""]);
  expect(JSON.parse(b.receipt).outcome).toBe("conflict");
});

test("local frontier clears once, stale merge retains C, old B never resurfaces", () => {
  let s = append(empty(), []);
  s = append(s.head, s.events, { opId: "b", payload: "Invented B" });
  s = append(s.head, s.events, { kind: "resolve", opId: "r1", baseRevision: 2, parents: ["event-2", "event-1"] });
  expect(s.head).toMatchObject({ clearedThrough: 3, pendingCount: 0 });
  s = append(s.head, s.events, { opId: "c", baseRevision: 0, payload: "Invented C" });
  s = append(s.head, s.events, { kind: "resolve", opId: "stale", baseRevision: 3, parents: ["event-3"] });
  expect(s.head).toMatchObject({ clearedThrough: 3, pendingCount: 2 });
  s = append(s.head, s.events, { kind: "resolve", opId: "r2", baseRevision: 5,
    parents: ["event-5", "event-3", "event-4"], payload: "Explicit invented choice" });
  expect(s.head).toMatchObject({ clearedThrough: 6, pendingCount: 0 });
  expect(s.events[1].payload).toBe("Invented B");
  expect(decide(scope, s.head, s.events, normalize(input({ baseRevision: 6 })))).toMatchObject({ accepted: true });
});

test("local lost-ack receipt equality ignores today's state; reuse rejects all changed fields", () => {
  const s = append(empty(), []), op = normalize(input());
  expect(replay(s.events[0], op)).toBe(s.receipt);
  expect(replay(s.events[0], op)).toBe(s.receipt);
  for (const patch of [{ payload: "changed" }, { baseRevision: 1 }, { questionId: "q-tide-r1" },
    { contentRevision: "older-r0" }, { deviceId: "other" }, { kind: "clear", payload: "" }]) {
    expect(() => replay(s.events[0], normalize(input(patch)))).toThrow("OP_ID_REUSE");
  }
  const old = normalize(input({ contentRevision: "older-r0" }));
  expect(replay({ normalizedRequest: old.json, receipt: s.receipt }, old)).toBe(s.receipt);
  expect(() => decide(scope, empty(), [], old)).toThrow("CONTENT_REVISION");
});

test("local normalization rejects malformed Unicode, unknown keys and invalid bounds", () => {
  for (const patch of [{ ownerId: "forged" }, { payload: "\ud800" }, { payload: "\udc00" },
    { payload: "\0" }, { payload: "😀".repeat(513) }, { payload: "\n".repeat(2048) },
    { baseRevision: NaN }, { baseRevision: Infinity }, { baseRevision: -1 },
    { baseRevision: 2 ** 53 }, { parents: Array(18).fill("x") }, { deviceId: "é".repeat(33) },
    { parents: ["x", "x"], kind: "resolve" }, { parents: ["x"] }, { kind: "clear" }]) {
    expect(() => normalize(input(patch))).toThrow();
  }
  expect(normalize(input({ payload: "😀".repeat(512) })).value.payload.length).toBe(1024);
  expect(normalize(input({ kind: "resolve", parents: ["z", "a"] })).value.parents).toEqual(["a", "z"]);
  expect(() => sealReceipt({ value: "x".repeat(513) })).toThrow("CAPACITY");
});

test("local scope and frontier integrity reject foreign evidence without changing inputs", () => {
  const s = append(empty(), []), before = JSON.stringify(s);
  const pending = append(s.head, s.events, { opId: "pending" });
  for (const patch of [{ ownerId: "foreign" }, { dashboardId: "foreign" },
    { questionId: "q-tide-r1" }, { field: "note" as const }]) {
    const canonical = [{ ...s.events[0], ...patch }];
    expect(() => decide(scope, s.head, canonical, normalize(input({ baseRevision: 1 })))).toThrow("DENIED");
    const parent = [pending.events[0], { ...pending.events[1], ...patch }];
    const resolution = normalize(input({ kind: "resolve", baseRevision: 2, parents: parent.map(e => e.id) }));
    expect(() => decide(scope, pending.head, parent, resolution)).toThrow("DENIED");
  }
  expect(() => decide(scope, { ...s.head, pendingCount: 1 }, s.events, normalize(input()))).toThrow("INTEGRITY_ERROR");
  expect(() => decide(scope, s.head, s.events, normalize(input({ kind: "resolve", parents: ["unknown"] })))).toThrow("DENIED");
  expect(JSON.stringify(s)).toBe(before);
});

test("local pending cap blocks extra conflicts but allows complete explicit resolution", () => {
  let s = append(empty(), []);
  for (let i = 0; i < LIMITS.MAX_PENDING; i++) s = append(s.head, s.events, { opId: `c-${i}` });
  const before = JSON.stringify(s);
  expect(() => append(s.head, s.events, { opId: "overflow" })).toThrow("CAPACITY");
  expect(JSON.stringify(s)).toBe(before);
  const resolved = append(s.head, s.events, { kind: "resolve", opId: "resolve", baseRevision: s.head.revision,
    parents: s.events.map(e => e.id), payload: "" });
  expect(resolved.head.pendingCount).toBe(0);
});

test("local independent field decisions preserve both values", () => {
  const a = append(empty(), []);
  const noteScope = { ...scope, field: "note" as const };
  const op = normalize(input({ field: "note", payload: "Invented note" }));
  expect(decide(noteScope, empty(), [], op).accepted).toBe(true);
  expect(a.events[0].payload).toBe("Invented orbit: 7");
});


test("local unresolved frontier blocks a matching-base save and retains incomplete resolution", () => {
  let s = append(empty(), []);
  s = append(s.head, s.events, { opId: "b" });
  const incomplete = append(s.head, s.events, { kind: "resolve", opId: "partial", baseRevision: 2, parents: ["event-1"] });
  expect(incomplete.head).toMatchObject({ clearedThrough: 1, pendingCount: 2 });
  const ordinary = append(s.head, s.events, { opId: "ordinary", baseRevision: 2 });
  expect(ordinary.head).toMatchObject({ clearedThrough: 1, pendingCount: 2 });
  const a = normalize(input({ kind: "resolve", parents: ["event-1"] }));
  const b = normalize(input({ kind: "resolve", parents: ["event-1", "event-2"] }));
  expect(() => replay({ normalizedRequest: a.json, receipt: s.receipt }, b)).toThrow("OP_ID_REUSE");
});

test("local UTF-8 byte counts match native encoding at exact boundaries", () => {
  for (const text of ["ASCII", "é", "漢", "😀", "aé漢😀"]) {
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(boundedText(text, bytes)).toBe(text);
    expect(() => boundedText(text, bytes - 1)).toThrow("CAPACITY");
  }
  const s = append(empty(), []);
  expect(() => decide(scope, s.head, [{ ...s.events[0], id: "x".repeat(65) }], normalize(input()))).toThrow("CAPACITY");
});

test.each(["baseRevision", "kind", "field", "parents"] as const)("local request accessor %s is rejected without invocation", key => {
  const raw = input(), value = raw[key];
  let reads = 0;
  Object.defineProperty(raw, key, { enumerable: true, get() {
    reads++;
    return key === "baseRevision" && reads > 1 ? NaN : value;
  } });
  expect(() => normalize(raw)).toThrow("VALIDATION");
  expect(reads).toBe(0);
});

test("local parent arrays reject holes, custom prototypes and accessor elements", () => {
  for (const parents of [Array(1), ["a", , "b"], Object.setPrototypeOf(["a"], {})]) {
    expect(() => normalize(input({ kind: "resolve", parents }))).toThrow("VALIDATION");
  }
  let reads = 0;
  const parents = ["a"];
  Object.defineProperty(parents, "0", { get() { reads++; return "a"; } });
  expect(() => normalize(input({ kind: "resolve", parents }))).toThrow("VALIDATION");
  expect(reads).toBe(0);
});

test("local dense parent snapshot ignores input-supplied map and sort", () => {
  let calls = 0;
  const parents = Object.assign(["b", "a"], {
    map() { calls++; return ["forged"]; }, sort() { calls++; return ["forged"]; },
  });
  expect(normalize(input({ kind: "resolve", parents })).value.parents).toEqual(["a", "b"]);
  expect(calls).toBe(0);
});

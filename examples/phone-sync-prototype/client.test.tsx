/** @jsxImportSource preact */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { options, render, type VNode } from "preact";
import { act } from "preact/test-utils";
import { Player, WORDS } from "./capsule/client/player";
import { Answers } from "./capsule/client/sync";
import { normalize } from "./capsule/shared/protocol";
import { createHarness, useHarnessPort, type Harness } from "./harness/backend";

// happy-dom component tests (pattern: tests/dashboard-dom.test.ts). The port is harness/backend.ts:
// store.ts/reads.ts over memory-db with injected accounts. LOCAL ADAPTER EVIDENCE, not signed-in Lakebed.
const win = new Window({ url: "https://local.test/" }) as any;
const media = { plays: 0 };
const proto = win.HTMLMediaElement.prototype;
proto.play = function () { this._paused = false; media.plays++; this.dispatchEvent(new win.Event("play")); return Promise.resolve(); };
proto.pause = function () { this._paused = true; this.dispatchEvent(new win.Event("pause")); };
Object.defineProperty(proto, "paused", { configurable: true, get() { return this._paused !== false; } });
Object.assign(globalThis, { document: win.document, localStorage: win.localStorage,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout });
// preact/hooks detects rAF at import (before the stub above) and otherwise waits 35 ms for effects queued
// outside act(), e.g. after a server update; run them on the next tick so flush() really sees them.
options.requestAnimationFrame = cb => void setTimeout(cb, 0);

let root: any;
beforeEach(() => { win.localStorage.clear(); media.plays = 0; root = win.document.body.appendChild(win.document.createElement("div")); });
afterEach(() => { render(null, root); root.remove(); });
const $ = (selector: string) => root.querySelector(selector);
// act() defers renders and effects to its end, so each async hop gets its own act.
const flush = async () => { for (let i = 0; i < 8; i++) await act(() => new Promise<void>(r => setTimeout(r, 0))); };
const mount = async (node: VNode) => { act(() => render(node, root)); await flush(); };
const tone = () => Promise.resolve(new Blob(["synthetic"], { type: "audio/wav" }));
const fire = (el: any, type: string) => el.dispatchEvent(new win.Event(type, { bubbles: true }));

test("player renders without autoplay", async () => {
  await mount(<Player source={tone} />);
  expect($("audio").hasAttribute("autoplay")).toBe(false);
  expect(media.plays).toBe(0);
  expect($("audio").paused).toBe(true);
});

test("seek, word tap and restart while paused stay paused; seeks clamp", async () => {
  await mount(<Player source={tone} />);
  const range = $("input[type=range]");
  range.value = "2.5"; fire(range, "input"); fire(range, "change");
  expect($("audio").currentTime).toBe(2.5);
  act(() => $("[data-word='2']").click());
  expect($("audio").currentTime).toBe(WORDS[2][1]);
  act(() => $("button[aria-label=Restart]").click());
  expect([$("audio").currentTime, media.plays, $("audio").paused]).toEqual([0, 0, true]);
  act(() => $("button[aria-label=Play]").click());
  act(() => $("[data-word='1']").click());
  expect($("audio").paused).toBe(false);
});

test("speed applies to the audio element", async () => {
  await mount(<Player source={tone} />);
  act(() => $("[data-speed='1.5']").click());
  expect($("audio").playbackRate).toBe(1.5);
  expect($("[data-speed='1.5']").getAttribute("aria-pressed")).toBe("true");
});

test("review: upper seek clamp handles an out-of-range event", async () => {
  await mount(<Player source={tone} />);
  const range = $("input[type=range]");
  Object.defineProperty(range, "value", { configurable: true, value: "1000" });
  act(() => fire(range, "change"));
  expect($("audio").currentTime).toBe(6.5);
});

test("review: lower seek clamp handles an out-of-range event", async () => {
  await mount(<Player source={tone} />);
  const range = $("input[type=range]");
  Object.defineProperty(range, "value", { configurable: true, value: "-1000" });
  act(() => fire(range, "change"));
  expect($("audio").currentTime).toBe(0);
});

test("review: playback cannot yank the seek thumb during scrubbing", async () => {
  await mount(<Player source={tone} />);
  const range = $("input[type=range]");
  range.value = "2.5"; act(() => fire(range, "input"));
  $("audio").currentTime = 4; act(() => fire($("audio"), "timeupdate"));
  expect(range.value).toBe("2.5");
  act(() => fire(range, "change"));
  $("audio").currentTime = 5; act(() => fire($("audio"), "timeupdate"));
  expect(range.value).toBe("5");
});

function View({ h, account }: { h: Harness; account: string }) { return <Answers port={useHarnessPort(h, account)} />; }
const field = (q: string, f = "answer") => $(`[data-field='${q}:${f}']`);
const state = (q: string, f = "answer") => field(q, f).getAttribute("data-state");
const text = (q: string, f = "answer") => field(q, f).querySelector("textarea").value;
async function type(q: string, value: string, f = "answer") {
  const area = field(q, f).querySelector("textarea");
  area.value = value; fire(area, "input"); await flush();
}
const button = (q: string, label: string, f = "answer") =>
  [...field(q, f).querySelectorAll("button")].find((b: any) => b.textContent === label) as any;
const Q = "q-orbit-r1";

test("field states: empty -> unsaved draft -> saving -> saved, refresh-safe", async () => {
  const h = createHarness();
  await mount(<View h={h} account="alice" />);
  expect(state(Q)).toBe("empty");
  const fades = () => field(Q).querySelector("[role=status]").className.includes("starting:opacity-0");
  expect(fades()).toBe(false); // no entrance fade on first load
  await type(Q, "Invented answer");
  expect([state(Q), fades()]).toEqual(["draft", true]);
  await mount(<View h={h} account="alice" key="refresh" />);
  expect([state(Q), text(Q)]).toEqual(["draft", "Invented answer"]);
  act(() => button(Q, "Save").click());
  expect(state(Q)).toBe("saving");
  await flush();
  expect([state(Q), text(Q)]).toEqual(["saved", "Invented answer"]);
});

test("a dirty draft survives a server update; conflict shows both and resolves with the full parent set", async () => {
  const h = createHarness();
  await mount(<View h={h} account="alice" />);
  await type(Q, "Mine");
  await h.otherDevice("alice", Q, "answer", "Theirs");
  await flush();
  expect([state(Q), text(Q)]).toEqual(["draft", "Mine"]);
  act(() => button(Q, "Save").click()); await flush();
  expect([state(Q), text(Q)]).toEqual(["conflict", "Mine"]); // the editor keeps this phone's text (T1)
  expect([...field(Q).querySelectorAll("[data-value] button")].map((b: any) => b.textContent))
    .toEqual(["Keep the other device's", "Keep yours (this phone)"]);
  const values = [...field(Q).querySelectorAll("[data-value]")].map((n: any) => n.getAttribute("data-value"));
  expect(values).toEqual(["Theirs", "Mine"]);
  const heads = await h.heads("alice");
  const frontier = [heads[0]!.canonical!.id, heads[0]!.pending[0]!.id].sort();
  act(() => field(Q).querySelectorAll("[data-value] button")[0].click()); await flush();
  expect(h.calls.at(-1)).toMatchObject({ kind: "resolve", parents: frontier, payload: "Theirs", baseRevision: 2 });
  expect([state(Q), text(Q)]).toEqual(["saved", "Theirs"]);
});

test("capacity keeps the draft, visibly unsaved", async () => {
  const h = createHarness();
  await h.fillCapacity();
  await mount(<View h={h} account="alice" />);
  await type(Q, "Kept on this phone");
  act(() => button(Q, "Save").click()); await flush();
  expect([state(Q), text(Q)]).toEqual(["capacity", "Kept on this phone"]);
  expect(win.localStorage.getItem(`nl-phone-sync:alice:${Q}:answer`)).toContain("Kept on this phone");
});

test("a lost acknowledgement stays uncertain, then reconciles via receipt with no resend", async () => {
  const h = createHarness();
  h.setDropAcks(true);
  await mount(<View h={h} account="alice" />);
  await type(Q, "Landed quietly");
  act(() => button(Q, "Save").click()); await flush();
  expect(state(Q)).toBe("uncertain");
  // While the receipt read is still pending this is "checking", not "no record": nothing offers a resend yet.
  expect([field(Q).textContent.includes("Checking before anything is sent again"), !!button(Q, "Save")]).toEqual([true, false]);
  h.setDropAcks(false); await flush();
  expect([state(Q), text(Q), h.calls.length]).toEqual(["saved", "Landed quietly", 1]);
});

test("account switch freezes the old account's draft and outbox, reconciling on return", async () => {
  const h = createHarness();
  h.setDropAcks(true);
  await mount(<View h={h} account="alice" key="alice" />);
  await type(Q, "Alice only");
  await type("q-tide-r1", "Alice note", "note");
  act(() => button(Q, "Save").click()); await flush();
  await mount(<View h={h} account="bob" key="bob" />);
  expect([state(Q), text(Q), text("q-tide-r1", "note")]).toEqual(["empty", "", ""]);
  h.setDropAcks(false);
  await mount(<View h={h} account="alice" key="alice" />);
  expect([state(Q), state("q-tide-r1", "note"), text("q-tide-r1", "note"), h.calls.length]).toEqual(["saved", "draft", "Alice note", 1]);
});

test("a switch mid-save freezes the outbox; on return it is uncertain until a receipt reconciles it", async () => {
  const h = createHarness();
  h.latency = 30;
  await mount(<View h={h} account="alice" key="alice" />);
  await type(Q, "In flight");
  act(() => button(Q, "Save").click());
  await mount(<View h={h} account="bob" key="bob" />);
  await new Promise(r => setTimeout(r, 60)); await flush();
  expect(JSON.parse(win.localStorage.getItem(`nl-phone-sync:alice:${Q}:answer`))).toMatchObject({ text: "In flight", account: "alice", outbox: "sending", op: h.calls[0] });
  h.setDropAcks(true);
  await mount(<View h={h} account="alice" key="alice" />);
  expect(state(Q)).toBe("uncertain");
  h.setDropAcks(false); await flush();
  expect([state(Q), text(Q), h.calls.length]).toEqual(["saved", "In flight", 1]);
});

test("review: returning before original save commits must not fork the outbox", async () => {
  const h = createHarness(); h.latency = 300;
  await mount(<View h={h} account="alice" key="alice" />);
  await type(Q, "One logical edit");
  act(() => button(Q, "Save").click());
  await mount(<View h={h} account="bob" key="bob" />);
  await mount(<View h={h} account="alice" key="alice" />);
  expect(state(Q)).toBe("uncertain"); // fix round 2: a null receipt keeps the original operation and uncertainty
  act(() => button(Q, "Save").click());
  await new Promise(r => setTimeout(r, 350)); await flush();
  const head = (await h.heads("alice"))
    .find(x => x.questionId === Q && x.field === "answer")!;
  console.log("REVIEW-RACE", JSON.stringify({
    calls: h.calls, revision: head.revision,
    pending: head.pending.map(x => x.payload)
  }));
  expect(h.calls[1]).toEqual(h.calls[0]);
  expect(head.revision).toBe(1);
  expect(head.pending).toHaveLength(0);
});

test("a request lost before commit, with no receipt, is retried under the original opId and bytes", async () => {
  const h = createHarness();
  h.failNext = true;
  await mount(<View h={h} account="alice" />);
  await type(Q, "Retried exactly");
  act(() => button(Q, "Save").click()); await flush();
  expect([state(Q), field(Q).textContent.includes("no record of this save")]).toEqual(["uncertain", true]);
  act(() => button(Q, "Save").click()); await flush();
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]!.opId).toBe(h.calls[0]!.opId);
  expect(normalize(h.calls[1]).json).toBe(normalize(h.calls[0]).json);
  expect([state(Q), text(Q)]).toEqual(["saved", "Retried exactly"]);
});

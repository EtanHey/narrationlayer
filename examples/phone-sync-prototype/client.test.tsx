/** @jsxImportSource preact */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { options, render, type VNode } from "preact";
import { act } from "preact/test-utils";
import { Player, WORDS } from "./capsule/client/player";
import { Answers } from "./capsule/client/sync";
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
  await type(Q, "Invented answer");
  expect(state(Q)).toBe("draft");
  await mount(<View h={h} account="alice" key="refresh" />);
  expect([state(Q), text(Q)]).toEqual(["draft", "Invented answer"]);
  act(() => button(Q, "Save").click());
  expect(state(Q)).toBe("saving");
  await flush();
  expect([state(Q), text(Q)]).toEqual(["saved", "Invented answer"]);
});

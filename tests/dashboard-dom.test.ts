import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { Window } from "happy-dom";

import { createJobFromPayload, renderJob } from "../src/service.js";
import { createDashboardDemo } from "../src/dashboard.js";

// Behavioral (headless DOM) verification of the teleprompter/playlist backbone.
// String `toContain` checks prove the code is present; these prove it works:
// the inline dashboard script is executed against a real DOM + media element
// and the five inherited bugs are asserted on observable state.

// The project tsconfig has no `DOM` lib, so DOM globals (Document, HTMLElement,
// ...) are intentionally typed loosely here; happy-dom provides them at runtime.
interface Harness {
  window: Window;
  document: any;
  audio: any;
  tabs: any[];
  words: () => any[];
  activeIndex: () => number;
  playCalls: () => number;
  press: (key: string) => void;
  emit: (target: any, type: string) => void;
  cleanup: () => void;
}

async function setupDashboard(segmentCount: number): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "nl-dashdom-"));
  const segments = Array.from({ length: segmentCount }, (_, i) => ({
    id: `seg-${i + 1}`,
    title: `Segment ${i + 1}`,
    script: `Words for segment number ${i + 1} go right here now.`,
    duration_seconds: 4 + i,
  }));
  await createJobFromPayload(
    {
      job_id: "dom-job",
      voice_profile: "neutral-reader",
      renderer: "fake",
      segments,
    },
    dataDir,
  );
  await renderJob("dom-job", dataDir);
  const htmlPath = await createDashboardDemo("dom-job", dataDir);
  const html = await Bun.file(htmlPath).text();

  const window = new Window({
    url: "https://local.test/",
    settings: { disableJavaScriptEvaluation: true },
  });
  const document = window.document as any;

  // Deterministic media element: no real audio, so duration is NaN and the code
  // falls back to segment duration_seconds. Track play() calls.
  const state = { plays: 0 };
  const proto = (window as any).HTMLMediaElement.prototype;
  Object.defineProperty(proto, "duration", {
    configurable: true,
    get() {
      return NaN;
    },
  });
  proto.play = function () {
    this._paused = false;
    state.plays += 1;
    return Promise.resolve();
  };
  proto.pause = function () {
    this._paused = true;
  };
  proto.load = function () {};
  Object.defineProperty(proto, "paused", {
    configurable: true,
    get() {
      return this._paused !== false;
    },
    set(v) {
      this._paused = v;
    },
  });

  (document as any).write(html);
  const scriptEl = [...document.querySelectorAll("script")].find((s) =>
    (s.textContent || "").includes("function jumpToSegment"),
  );
  if (!scriptEl) throw new Error("dashboard logic script not found");
  // Execute with rAF stubbed to a no-op so the teleprompter highlight loop does
  // not spin; setActiveWord is still driven synchronously by seek/scrub.
  const runner = new Function(
    "document",
    "requestAnimationFrame",
    scriptEl.textContent as string,
  );
  runner(document, () => 0);

  const audio = document.getElementById("audio") as any;
  const tabs = [...document.querySelectorAll(".segment-tab")] as any[];

  return {
    window,
    document,
    audio,
    tabs,
    words: () => [...document.querySelectorAll(".word")] as any[],
    activeIndex: () => {
      const active = document.querySelector(".segment-tab.active") as any;
      return active ? Number(active.dataset.segmentIndex) : -1;
    },
    playCalls: () => state.plays,
    press: (key) =>
      document.dispatchEvent(
        new (window as any).KeyboardEvent("keydown", { key, bubbles: true }),
      ),
    emit: (target, type) =>
      target.dispatchEvent(new (window as any).Event(type)),
    cleanup: () => {
      (window as any).happyDOM?.abort?.();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("init loads first segment without autoplay", async () => {
  const h = await setupDashboard(3);
  try {
    expect(h.document.getElementById("segment-title")!.textContent).toBe(
      "Segment 1",
    );
    expect(h.audio.src.endsWith("seg-1.mp3")).toBe(true);
    expect(h.words().length).toBeGreaterThan(0);
    expect(h.playCalls()).toBe(0); // init must not autoplay
    expect(h.activeIndex()).toBe(0);
  } finally {
    h.cleanup();
  }
});

test("BUG 3: clicking a never-played section loads AND plays it", async () => {
  const h = await setupDashboard(4);
  try {
    expect(h.audio.src.endsWith("seg-1.mp3")).toBe(true);
    const before = h.playCalls();
    h.tabs[2].click(); // section never played yet
    expect(h.audio.src.endsWith("seg-3.mp3")).toBe(true); // loaded
    expect(h.playCalls()).toBe(before + 1); // and played, not nothing/restart
    expect(h.activeIndex()).toBe(2);
  } finally {
    h.cleanup();
  }
});

test("BUG 2: word click seeks to that word and does not restart", async () => {
  const h = await setupDashboard(2);
  try {
    const word = h.words()[3];
    const start = Number(word.dataset.start);
    expect(start).toBeGreaterThan(0);

    // While playing: seek to word, keep playing (no restart to 0).
    h.audio.play();
    const playsBefore = h.playCalls();
    word.click();
    expect(h.audio.currentTime).toBeCloseTo(start, 5);
    expect(h.audio.currentTime).not.toBe(0);
    expect(h.playCalls()).toBe(playsBefore + 1); // resumed, not restarted from scratch

    // While paused: seek but stay paused (no spurious play).
    h.audio.pause();
    const w2 = h.words()[1];
    const start2 = Number(w2.dataset.start);
    const pausedPlays = h.playCalls();
    w2.click();
    expect(h.audio.currentTime).toBeCloseTo(start2, 5);
    expect(h.playCalls()).toBe(pausedPlays); // paused stays paused
  } finally {
    h.cleanup();
  }
});

test("BUG 1: scrubber is two-way bound to currentTime", async () => {
  const h = await setupDashboard(2);
  try {
    const scrubber = h.document.getElementById("scrubber") as any;
    // scrubber -> audio
    scrubber.value = "2.5";
    h.emit(scrubber, "input");
    expect(h.audio.currentTime).toBeCloseTo(2.5, 5);
    scrubber.value = "1.0";
    h.emit(scrubber, "change");
    expect(h.audio.currentTime).toBeCloseTo(1.0, 5);
    // audio -> scrubber (timeupdate reflects back)
    h.audio.currentTime = 3.25;
    h.emit(h.audio, "timeupdate");
    expect(Number(scrubber.value)).toBeCloseTo(3.25, 5);
  } finally {
    h.cleanup();
  }
});

test("BUG 4: j/k repeat — three presses move three segments", async () => {
  const h = await setupDashboard(5);
  try {
    expect(h.activeIndex()).toBe(0);
    h.press("j");
    h.press("j");
    h.press("j");
    expect(h.activeIndex()).toBe(3); // jjj == 3 forward moves
    expect(h.audio.src.endsWith("seg-4.mp3")).toBe(true);
    h.press("k");
    h.press("k");
    expect(h.activeIndex()).toBe(1); // kk == 2 backward moves
    expect(h.audio.src.endsWith("seg-2.mp3")).toBe(true);
  } finally {
    h.cleanup();
  }
});

test("BUG 5: Back / Next buttons move between segments", async () => {
  const h = await setupDashboard(3);
  try {
    const next = h.document.getElementById("next-segment") as any;
    const back = h.document.getElementById("previous-segment") as any;
    next.click();
    expect(h.activeIndex()).toBe(1);
    expect(h.audio.src.endsWith("seg-2.mp3")).toBe(true);
    next.click();
    expect(h.activeIndex()).toBe(2);
    back.click();
    expect(h.activeIndex()).toBe(1);
  } finally {
    h.cleanup();
  }
});

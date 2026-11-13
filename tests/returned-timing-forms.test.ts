// Pins every shape of a returned word timing that src/timing/returned-timings.ts accepts or
// rejects, and the timing source a rendered job names when the engine's timings are unusable.
// Follow-up to the Codex review of PR #71: mixed forms in one payload, partial shapes, and the
// mirror image of "the daemon wins" in tests/sample-r2-survivors.test.ts.
// Synthetic inputs only; every write goes to a temporary directory; the TTS daemon is a stub.
// Tests whose names start with "pinned as is:" record behaviour that may be wrong; they pin what
// the code does today so that a change is deliberate, not that the behaviour is endorsed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { normalizeReturnedTimings } from "../src/timing/returned-timings.js";
import { renderSegment } from "../src/pipelines/job-render/index.js";
import type { WordTimingResult } from "../src/core/render-types.js";
import type { WordTiming } from "../src/schema.js";

const list = (word_timings: unknown) => normalizeReturnedTimings({ word_timings, words: undefined, word_boundaries: undefined });

// ---------------------------------------------------------------------------------------------
// Mixed forms in one payload
// ---------------------------------------------------------------------------------------------

test("mixed forms in one word list: each word keeps its own start and end, in order", () => {
  expect(
    list([
      { word: "One", offset_ms: 0, duration_ms: 250 },
      { word: "two", start: 0.3, end: 0.55 },
      { word: "three", start_seconds: 0.6, end_seconds: 0.95 },
      { text: "four", offset_ms: 1000, duration_ms: 125, confidence: 0.9 },
      { word: "five", start: 1.2, end_seconds: 1.4 },
      { word: "six", start_seconds: 1.5, offset_ms: 9999, duration_ms: 1 },
    ]),
  ).toEqual([
    { index: 0, word: "One", start: 0, end: 0.25 },
    { index: 1, word: "two", start: 0.3, end: 0.55 },
    { index: 2, word: "three", start: 0.6, end: 0.95 },
    { index: 3, word: "four", start: 1, end: 1.125, confidence: 0.9 },
    { index: 4, word: "five", start: 1.2, end: 1.4 },
    // start_seconds wins for the start; the end comes from offset+duration.
    { index: 5, word: "six", start: 1.5, end: 10 },
  ]);
});

test("one word carrying every form: start/end beat start_seconds/end_seconds beat offset_ms/duration_ms", () => {
  const all = { start: 1, end: 2, start_seconds: 3, end_seconds: 4, offset_ms: 5000, duration_ms: 1000 };
  expect(list([{ word: "a", ...all }])).toEqual([{ index: 0, word: "a", start: 1, end: 2 }]);
  const { start: _s, end: _e, ...noStartEnd } = all;
  expect(list([{ word: "b", ...noStartEnd }])).toEqual([{ index: 0, word: "b", start: 3, end: 4 }]);
});

test("a zero start or offset is a real value, not a missing one", () => {
  expect(list([{ word: "a", start: 0, end: 0.2 }, { word: "b", offset_ms: 0, duration_ms: 0 }])).toEqual([
    { index: 0, word: "a", start: 0, end: 0.2 },
    { index: 1, word: "b", start: 0, end: 0 },
  ]);
});

test("seconds are rounded to three decimals; an explicit index wins over the position", () => {
  expect(list([{ word: "a", index: 7, offset_ms: 123.4567, duration_ms: 100.0004 }])).toEqual([
    { index: 7, word: "a", start: 0.123, end: 0.223 },
  ]);
});

// ---------------------------------------------------------------------------------------------
// Partial and malformed shapes: what happens today
// ---------------------------------------------------------------------------------------------

test("an offset with no duration drops that word only; the rest of the list survives", () => {
  expect(
    list([
      { word: "kept", offset_ms: 0, duration_ms: 200 },
      { word: "dropped", offset_ms: 300 },
      { word: "also", offset_ms: 600, duration_ms: 200 },
    ]),
  ).toEqual([
    { index: 0, word: "kept", start: 0, end: 0.2 },
    // The index is the raw position, so a dropped word leaves a gap (0, 2).
    { index: 2, word: "also", start: 0.6, end: 0.8 },
  ]);
});

test("each partial shape with no usable start or end drops its word", () => {
  const partials = [
    { word: "duration-only", duration_ms: 200 },
    { word: "end-only", end: 0.5 },
    { word: "start-only", start: 0.5 },
    { word: "end-seconds-only", end_seconds: 0.5 },
    { word: "start-seconds-only", start_seconds: 0.5 },
    { word: "string-numbers", start: "0.1", end: "0.2" },
    { word: "nan", start: Number.NaN, end: 0.2 },
    { word: "infinite", start: 0, end: Number.POSITIVE_INFINITY },
    { word: "null-offset", offset_ms: null, duration_ms: 100 },
    { word: "   ", start: 0, end: 0.1 },
    { start: 0, end: 0.1 },
    { word: 42, start: 0, end: 0.1 },
  ];
  for (const partial of partials) {
    expect(list([partial]), JSON.stringify(partial)).toEqual([]);
  }
});

test("entries that are not objects are dropped without losing their neighbours", () => {
  expect(list([null, 3, "word", ["a", 0, 1], { word: "ok", start: 0, end: 1 }])).toEqual([
    { index: 4, word: "ok", start: 0, end: 1 },
  ]);
});

test("pinned as is: a negative start or offset is kept, not dropped or clamped", () => {
  expect(list([{ word: "neg", start: -0.5, end: 0.2 }, { word: "negoff", offset_ms: -100, duration_ms: 50 }])).toEqual([
    { index: 0, word: "neg", start: -0.5, end: 0.2 },
    { index: 1, word: "negoff", start: -0.1, end: -0.05 },
  ]);
});

test("pinned as is: an end before its start is kept, not dropped or swapped", () => {
  expect(list([{ word: "backwards", start: 2, end: 1 }, { word: "negdur", offset_ms: 500, duration_ms: -200 }])).toEqual([
    { index: 0, word: "backwards", start: 2, end: 1 },
    { index: 1, word: "negdur", start: 0.5, end: 0.3 },
  ]);
});

test("the list comes from word_timings, else words, else word_boundaries; a non-array yields nothing", () => {
  const w = (word: string) => [{ word, start: 0, end: 1 }];
  const pick = (payload: { word_timings?: unknown; words?: unknown; word_boundaries?: unknown }) =>
    normalizeReturnedTimings({ word_timings: payload.word_timings, words: payload.words, word_boundaries: payload.word_boundaries }).map(
      (timing) => timing.word,
    );
  expect(pick({ word_timings: w("wt"), words: w("w"), word_boundaries: w("wb") })).toEqual(["wt"]);
  expect(pick({ word_timings: null, words: w("w"), word_boundaries: w("wb") })).toEqual(["w"]);
  expect(pick({ word_boundaries: w("wb") })).toEqual(["wb"]);
  // An empty word_timings array does not fall through to words.
  expect(pick({ word_timings: [], words: w("w") })).toEqual([]);
  // pinned as is: a present but non-array word_timings does not fall through either.
  expect(pick({ word_timings: { word: "x" }, words: w("w") })).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// The fallback is named: the mirror image of "the daemon wins" in sample-r2-survivors
// ---------------------------------------------------------------------------------------------

const script = "Hello from the local daemon";
// Every word is an offset with no duration: the daemon returned timings, none usable.
const unusableDaemonWords = script.split(" ").map((word, index) => ({ word, offset_ms: 100 + index * 400 }));

async function renderWith(
  daemonWords: unknown[],
  provider?: () => Promise<WordTiming[] | WordTimingResult>,
): Promise<{ timing: unknown; words: WordTiming[]; providerCalls: number }> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "nl-timing-forms-"));
  let providerCalls = 0;
  const fetchMock = async (): Promise<Response> =>
    Response.json({
      audio_b64: Buffer.from("synthetic audio bytes").toString("base64"),
      duration_ms: 2400,
      word_timings: daemonWords,
    });
  try {
    const result = await renderSegment(
      "seg-1",
      { title: "Intro", script },
      {
        artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
        dataDir,
        jobId: "job-1",
        voiceProfile: "neutral-reader",
        fetch: fetchMock,
      },
      {
        daemon_url: "http://127.0.0.1:1",
        auth_token: "synthetic-token",
        reference_clip: path.join(dataDir, "reference.wav"),
        reference_text: "Synthetic reference.",
        audio_duration_probe: async () => 2.2,
        ...(provider
          ? {
              word_timing_provider: async () => {
                providerCalls += 1;
                return provider();
              },
            }
          : {}),
      },
    );
    const payload = JSON.parse(readFileSync(result.words_path, "utf8"));
    return { timing: payload.timing, words: payload.words, providerCalls };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const providerWords: WordTiming[] = script.split(" ").map((word, index) => ({ index, word, start: index * 0.4, end: index * 0.4 + 0.3 }));

test("unusable daemon timings: the provider's named source is recorded, not the daemon's", async () => {
  const rendered = await renderWith(unusableDaemonWords, async () => ({ source: "estimated", words: providerWords }));
  expect(rendered.providerCalls).toBe(1);
  expect(rendered.timing).toEqual({ status: "available", source: "estimated" });
  expect(rendered.words).toEqual(providerWords);
});

test("unusable daemon timings: a provider returning a bare word list is recorded as whisper-cli", async () => {
  const rendered = await renderWith(unusableDaemonWords, async () => providerWords);
  expect(rendered.providerCalls).toBe(1);
  expect(rendered.timing).toEqual({ status: "available", source: "whisper-cli" });
  expect(rendered.words).toEqual(providerWords);
});

test("unusable daemon timings and no fallback: the job says timings are unavailable and why", async () => {
  const rendered = await renderWith(unusableDaemonWords);
  expect(rendered.timing).toEqual({
    status: "unavailable",
    source: "voicelayer-qwen3",
    reason: "backend_did_not_return_word_timings",
  });
  expect(rendered.words).toEqual([]);
});

test("pinned as is: one usable daemon word is enough; the fallback is not consulted for the rest", async () => {
  const mixed = [{ word: "Hello", offset_ms: 100, duration_ms: 300 }, ...unusableDaemonWords.slice(1)];
  const rendered = await renderWith(mixed, async () => ({ source: "estimated", words: providerWords }));
  expect(rendered.providerCalls).toBe(0);
  expect(rendered.timing).toEqual({ status: "available", source: "voicelayer-qwen3" });
  expect(rendered.words).toEqual([{ index: 0, word: "Hello", start: 0.1, end: 0.4 }]);
});

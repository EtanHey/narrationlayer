import { expect, test } from "bun:test";
import { CUT_ENDING_DEFAULTS, cutEnding } from "../src/quality/take-checks.js";

// Synthetic takes only: a 200 Hz tone with a little seeded noise stands in for voiced speech.
const SR = 16000;
function take({ seconds = 2, tailSeconds = 0, tailDb = 0, decay = false, silence = 0, level = 0.2 } = {}) {
  const body = Math.round(SR * seconds), tail = Math.round(SR * tailSeconds);
  const decaySamples = decay ? Math.round(SR * 0.12) : 0;
  const samples = new Float32Array(body + tail + decaySamples + Math.round(SR * silence));
  let seed = 7;
  for (let i = 0; i < body + tail + decaySamples; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const gain = i < body ? 1 : i < body + tail ? 10 ** (tailDb / 20) : Math.exp(-(i - body - tail) / (SR * 0.015));
    samples[i] = level * gain * (Math.sin(2 * Math.PI * 200 * i / SR) + 0.05 * (seed / 2 ** 32 * 2 - 1));
  }
  return samples;
}
const words = (lastEnd: number) => [{ word: "Hello", start: 0.1, end: 0.6 }, { word: "moon.", start: 0.7, end: lastEnd }];

test("a take that stops mid-sound fails; trailing digital silence does not hide it", () => {
  const cut = cutEnding(take(), SR);
  expect(cut).toMatchObject({ failed: true, reason: "tail-at-speech-level" });
  expect(cut.tailRelDb!).toBeGreaterThan(-1);
  const padded = cutEnding(take({ silence: 0.1 }), SR);
  expect(padded).toMatchObject({ failed: true, reason: "tail-at-speech-level" });
  expect(padded.audioEndSeconds).toBeCloseTo(2, 3);
  expect(padded.durationSeconds).toBeCloseTo(2.1, 3);
});

test("a take that decays into a little silence passes, even when the recogniser stretches its last word", () => {
  const clean = cutEnding(take({ decay: true, silence: 0.15 }), SR);
  expect(clean).toMatchObject({ failed: false, reason: null });
  expect(clean.tailRelDb!).toBeLessThan(-30);
  const stretched = cutEnding(take({ decay: true, silence: 0.15 }), SR, words(2.4));
  expect(stretched.lastWordEndSeconds).toBe(2.4);
  expect(stretched.failed).toBe(false);
});

test("acoustic margin: a final window 7.7 dB under speech fails, 8.3 dB under passes", () => {
  expect(CUT_ENDING_DEFAULTS.maxTailRelDb).toBe(-8);
  const near = cutEnding(take({ tailSeconds: 0.05, tailDb: -7.7 }), SR);
  expect(near).toMatchObject({ failed: true, reason: "tail-at-speech-level" });
  expect(near.tailRelDb!).toBeCloseTo(-7.65, 1);
  const under = cutEnding(take({ tailSeconds: 0.05, tailDb: -8.3 }), SR);
  expect(under).toMatchObject({ failed: false, reason: null });
});

test("timing margin: the last word reaching the end lowers the bar to 12 dB, never to silence", () => {
  const sample = take({ tailSeconds: 0.05, tailDb: -10 });
  const end = sample.length / SR;
  expect(cutEnding(sample, SR).failed).toBe(false);
  expect(cutEnding(sample, SR, words(end - 0.02))).toMatchObject({ failed: true, reason: "last-word-runs-to-end" });
  expect(cutEnding(sample, SR, words(end - 0.021)).failed).toBe(false);
  expect(cutEnding(take({ tailSeconds: 0.05, tailDb: -11.7 }), SR, words(end)).failed).toBe(true);
  expect(cutEnding(take({ tailSeconds: 0.05, tailDb: -12.3 }), SR, words(end)).failed).toBe(false);
});

test("quiet, short and silent takes are not judged cut", () => {
  expect(cutEnding(take({ level: 0.002 }), SR)).toMatchObject({ failed: false, reason: null });
  expect(cutEnding(take({ level: 0.002 }), SR, [], { minTailDbfs: -60 }).failed).toBe(true);
  expect(cutEnding(take({ seconds: 0.03 }), SR)).toMatchObject({ failed: false, note: "not judged: too short or silent" });
  expect(cutEnding(new Float32Array(SR), SR)).toMatchObject({ failed: false, note: "not judged: too short or silent" });
});

test("invalid input is an error, not a verdict", () => {
  expect(() => cutEnding(take(), 100)).toThrow("invalid sample rate");
  expect(() => cutEnding(take(), SR, [], { maxTailRelDb: NaN })).toThrow("invalid cut-ending option");
  const bad = take();
  bad[10] = NaN;
  expect(() => cutEnding(bad, SR)).toThrow("nonfinite audio sample");
});

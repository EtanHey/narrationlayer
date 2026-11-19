import { expect, test } from "bun:test";
import { cutPieceEndings, type JoinedPieceAudio } from "../src/quality/take-checks.js";

// Synthetic pieces only: a 200 Hz tone with a little seeded noise stands in for one generation's speech.
const SR = 16000;
function piece(ending: "cut" | "decay" | "short-tail", seconds = 1) {
  const body = Math.round(SR * seconds), decay = ending === "decay" ? Math.round(SR * 0.12) : 0;
  const tail = ending === "short-tail" ? Math.round(SR * 0.05) : 0;
  const samples = new Float32Array(body + decay + tail + Math.round(SR * 0.05));
  let seed = 11;
  for (let i = 0; i < body + decay + tail; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const gain = i < body ? 1 : ending === "decay" ? Math.exp(-(i - body) / (SR * 0.015)) : 10 ** (-10 / 20);
    samples[i] = 0.2 * gain * (Math.sin(2 * Math.PI * 200 * i / SR) + 0.05 * (seed / 2 ** 32 * 2 - 1));
  }
  return samples;
}
function joined(...endings: ("cut" | "decay" | "short-tail")[]): JoinedPieceAudio[] {
  let start = 0;
  return endings.map(ending => {
    const samples = piece(ending);
    const at = { samples, startSeconds: start, spanSeconds: samples.length / SR + 0.55 };
    start += at.spanSeconds;
    return at;
  });
}

test("a piece cut mid-sound fails at its join; the last piece is left to the take's own check", () => {
  const judged = cutPieceEndings(joined("decay", "cut", "cut"), SR);
  expect(judged.map(j => j.index)).toEqual([0, 1]);
  expect(judged[0]!.result).toMatchObject({ failed: false, reason: null });
  expect(judged[0]!.result.tailRelDb!).toBeLessThan(-30);
  expect(judged[1]!.result).toMatchObject({ failed: true, reason: "tail-at-speech-level" });
  expect(judged[1]!.result.tailRelDb!).toBeGreaterThan(-1);
});

test("pieces that decay naturally pass, and a single piece has no join to judge", () => {
  expect(cutPieceEndings(joined("decay", "decay", "decay"), SR).every(j => !j.result.failed)).toBe(true);
  expect(cutPieceEndings(joined("cut"), SR)).toEqual([]);
  expect(cutPieceEndings([], SR)).toEqual([]);
});

test("each piece gets only its own words, shifted to its own start, for the timing bar", () => {
  const pieces = joined("short-tail", "decay");
  const end = pieces[0]!.samples.length / SR - 0.05;
  // A tail 10 dB under speech passes on loudness alone and fails only when that piece's last word runs to its end.
  expect(cutPieceEndings(pieces, SR)[0]!.result.failed).toBe(false);
  const second = { word: "moon.", start: pieces[1]!.startSeconds + 0.1, end: pieces[1]!.startSeconds + 0.9 };
  const early = cutPieceEndings(pieces, SR, [{ word: "Hello.", start: 0.1, end: 0.5 }, second])[0]!.result;
  expect(early).toMatchObject({ failed: false, lastWordEndSeconds: 0.5 });
  const late = cutPieceEndings(pieces, SR, [{ word: "Hello.", start: 0.1, end: end + 0.3 }, second])[0]!.result;
  expect(late).toMatchObject({ failed: true, reason: "last-word-runs-to-end" });
  expect(late.lastWordEndSeconds).toBeCloseTo(end + 0.3, 6);
});

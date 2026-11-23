import { spawnChecked } from "./support/spawn.js";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as checkTakeModule from "../src/quality/check-take.js";

// Synthetic audio only: a 180 Hz tone with seeded noise stands in for one take's speech.
// The take end needs no pieces: the finished WAV and its recognised words are enough.
const SR = 24000, SECONDS = 2, ROOT = "docs.local/check-take-end-test";

/**
 * The take's ending: stops at full level, decays into quiet, holds `tailDb` for its last 50 ms, or fades
 * out from full level at 10 dB per 10 ms over 50 ms (a word that fades before it is finished).
 */
type Ending = { kind: "cut" } | { kind: "decay" } | { kind: "tail"; tailDb: number } | { kind: "fade" };

function samples(ending: Ending): Float32Array {
  const body = Math.round(SR * SECONDS), tail = ending.kind === "tail" || ending.kind === "fade" ? Math.round(SR * 0.05) : 0;
  const decay = ending.kind === "decay" ? Math.round(SR * 0.12) : 0;
  const out = new Float32Array(body + tail + decay);
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const gain = i < body ? 1 : ending.kind === "tail" ? 10 ** (ending.tailDb / 20)
      : ending.kind === "fade" ? 10 ** (-10 * (i - body) / (SR * 0.01) / 20) : Math.exp(-(i - body) / (SR * 0.015));
    out[i] = 0.2 * gain * (Math.sin(2 * Math.PI * 180 * i / SR) + 0.05 * (seed / 2 ** 32 * 2 - 1));
  }
  return out;
}

function wav(file: string, data: Float32Array) {
  const pcm = Buffer.alloc(data.length * 2);
  data.forEach((v, i) => pcm.writeInt16LE(Math.round(v * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(file, Buffer.concat([header, pcm]));
}

/** Writes take.wav, sent and words.json; the last recognised word ends at `lastWordEnd` seconds. */
function take(name: string, ending: Ending, lastWordEnd = 1.5): string {
  const dir = `${ROOT}/${name}`;
  mkdirSync(dir, { recursive: true });
  wav(`${dir}/take.wav`, samples(ending));
  writeFileSync(`${dir}/sent`, "Hello moon.");
  writeFileSync(`${dir}/words.json`, JSON.stringify([{ word: "Hello", start: 0.2, end: 0.8 }, { word: "moon.", start: 0.9, end: lastWordEnd }]));
  return dir;
}

function checkTake(dir: string, rejectFades = false) {
  const run = spawnChecked([process.execPath, "src/cli.ts", "check-take", `${dir}/take.wav`, "--sent", `${dir}/sent`,
    "--words", `${dir}/words.json`, "--voice", "synthetic", "--pitch-ceiling", "300", ...(rejectFades ? ["--reject-fades"] : [])], { timeout: 20_000 });
  return { exitCode: run.exitCode, verdict: JSON.parse(run.stdout.toString()) };
}

test("check-take fails a take whose last sound is cut, with clean words and pitch", () => {
  const run = checkTake(take("cut", { kind: "cut" }));
  expect(run.exitCode).toBe(1);
  expect(run.verdict.pass).toBe(false);
  expect(run.verdict.wordMatch.pass).toBe(true);
  expect(run.verdict.firstWord.omitted).toBe(false);
  expect(run.verdict.pitch.failed).toBe(false);
  expect(run.verdict.cutEnding).toMatchObject({ failed: true, reason: "tail-at-speech-level", audioEndSeconds: SECONDS, lastWordEndSeconds: 1.5 });
  expect(run.verdict.cutEnding.tailRelDb).toBeGreaterThan(-1);
});

test("a natural decay passes, even when the recognised last word runs to the end", () => {
  for (const lastWordEnd of [1.5, SECONDS + 0.12]) {
    const run = checkTake(take(`decay-${lastWordEnd}`, { kind: "decay" }, lastWordEnd));
    expect(run.exitCode).toBe(0);
    expect(run.verdict.pass).toBe(true);
  }
});

test("check-take reports a decayed take end with the receipt's fields", () => {
  const run = checkTake(take("decay-1.5", { kind: "decay" }));
  expect(run.verdict.cutEnding).toMatchObject({ failed: false, reason: null, lastWordEndSeconds: 1.5 });
  expect(run.verdict.cutEnding.tailRelDb).toBeLessThan(-30);
});

test("the timing rule counts only together with loudness: a tail 10 dB under speech fails only when the last word runs to it", () => {
  const early = checkTake(take("tail-10-early", { kind: "tail", tailDb: -10 }));
  expect(early.exitCode).toBe(0);
  expect(early.verdict.cutEnding).toMatchObject({ failed: false, reason: null });
  expect(early.verdict.cutEnding.tailRelDb).toBeLessThan(-8);
  expect(early.verdict.cutEnding.tailRelDb).toBeGreaterThan(-12);
  const timed = checkTake(take("tail-10-timed", { kind: "tail", tailDb: -10 }, SECONDS + 0.05));
  expect(timed.exitCode).toBe(1);
  expect(timed.verdict.cutEnding).toMatchObject({ failed: true, reason: "last-word-runs-to-end" });
});

test("check-take fails a take whose last word fades out from speech level, though its tail is quiet", () => {
  const dir = take("fade", { kind: "fade" });
  expect(checkTake(dir).exitCode).toBe(0);
  expect(checkTake(dir).verdict.cutEnding.fadeDetected).toBe(true);
  const run = checkTake(dir, true);
  expect(run.exitCode).toBe(1);
  expect(run.verdict.wordMatch.pass).toBe(true);
  expect(run.verdict.pitch.failed).toBe(false);
  expect(run.verdict.cutEnding).toMatchObject({ failed: true, reason: "fade-from-speech-level", lastWordEndSeconds: 1.5 });
  expect(run.verdict.cutEnding.tailRelDb).toBeLessThan(-8);
  expect(run.verdict.cutEnding.fadeDbPer10ms).toBeGreaterThanOrEqual(7);
});

test("check-take's take end is the runner's: the receipt-shaped result of the one shared function", () => {
  // The runner's take loop calls this same export (src/pipelines/local-tts/index.ts).
  const { cutTakeEnd } = checkTakeModule;
  expect(cutTakeEnd).toBeFunction();
  for (const [name, ending, lastWordEnd] of [["cut", { kind: "cut" }, 1.5], ["decay-1.5", { kind: "decay" }, 1.5],
    ["tail-10-timed", { kind: "tail", tailDb: -10 }, SECONDS + 0.05], ["fade", { kind: "fade" }, 1.5]] as const) {
    const dir = take(name, ending, lastWordEnd);
    const words = [{ word: "Hello", start: 0.2, end: 0.8 }, { word: "moon.", start: 0.9, end: lastWordEnd }];
    const shared = cutTakeEnd(`${dir}/take.wav`, words);
    expect(Object.keys(shared).sort()).toEqual(["audioEndSeconds", "fadeDbPer10ms", "fadeDetected", "fadePeakRelDb", "failed", "lastWordEndSeconds", "reason", "tailRelDb"]);
    expect(checkTake(dir).verdict.cutEnding).toEqual(shared);
  }
});

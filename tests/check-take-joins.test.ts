import { spawnChecked } from "./support/spawn.js";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Synthetic audio only: a 180 Hz tone with seeded noise stands in for one generation's speech.
// Each case writes a take plus a `--keep-pieces`-shaped directory (piece WAVs + pieces.json).
const SR = 24000, PAUSE = 0.55, ROOT = "docs.local/check-take-joins-test";

function piece(ending: "cut" | "decay" | "fade", seconds = 1.5): Float32Array {
  const body = Math.round(SR * seconds), decay = ending === "decay" ? Math.round(SR * 0.12) : ending === "fade" ? Math.round(SR * 0.05) : 0;
  const samples = new Float32Array(body + decay);
  let seed = 7;
  for (let i = 0; i < samples.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const gain = i < body ? 1 : ending === "fade" ? 10 ** (-10 * (i - body) / (SR * 0.01) / 20) : Math.exp(-(i - body) / (SR * 0.015));
    samples[i] = 0.2 * gain * (Math.sin(2 * Math.PI * 180 * i / SR) + 0.05 * (seed / 2 ** 32 * 2 - 1));
  }
  return samples;
}

function wav(file: string, samples: Float32Array) {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => pcm.writeInt16LE(Math.round(v * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(file, Buffer.concat([header, pcm]));
}

/** Writes take.wav, pieces/ and the sent/words files; returns the case directory. */
function take(name: string, endings: ("cut" | "decay" | "fade")[], texts: string[]): string {
  const dir = `${ROOT}/${name}`;
  mkdirSync(`${dir}/pieces`, { recursive: true });
  const parts: Float32Array[] = [], rows = [], words = [];
  let offset = 0;
  for (const [index, ending] of endings.entries()) {
    const samples = piece(ending), pause = index < endings.length - 1 ? Math.round(SR * PAUSE) : 0;
    const file = `piece-${String(index).padStart(3, "0")}.wav`;
    wav(`${dir}/pieces/${file}`, samples);
    rows.push({ index, file, text: texts[index], samples: samples.length, durationSeconds: samples.length / SR,
      pauseAfterSamples: pause, pauseAfterSeconds: pause / SR, offsetSamples: offset, offsetSeconds: offset / SR });
    words.push({ word: texts[index], start: offset / SR + 0.2, end: offset / SR + 0.8 });
    parts.push(samples, new Float32Array(pause));
    offset += samples.length + pause;
  }
  writeFileSync(`${dir}/pieces/pieces.json`, JSON.stringify({ version: 1, totalSamples: offset, pieces: rows }));
  const whole = new Float32Array(offset);
  let at = 0;
  for (const part of parts) { whole.set(part, at); at += part.length; }
  wav(`${dir}/take.wav`, whole);
  writeFileSync(`${dir}/sent`, texts.join(" "));
  writeFileSync(`${dir}/words.json`, JSON.stringify(words));
  return dir;
}

function checkTake(dir: string, pieces: string | null = `${dir}/pieces`, rejectFades = false) {
  const run = spawnChecked([process.execPath, "src/cli.ts", "check-take", `${dir}/take.wav`, "--sent", `${dir}/sent`,
    "--words", `${dir}/words.json`, "--voice", "synthetic", "--pitch-ceiling", "300", ...(pieces === null ? [] : ["--pieces", pieces]), ...(rejectFades ? ["--reject-fades"] : [])], { timeout: 20_000 });
  return { exitCode: run.exitCode, stderr: run.stderr.toString(), verdict: run.exitCode === 2 ? null : JSON.parse(run.stdout.toString()) };
}

test("check-take --pieces fails a take whose first piece is cut at its join", () => {
  const run = checkTake(take("cut-join", ["cut", "decay"], ["Hello", "moon"]));
  expect(run.exitCode).toBe(1);
  expect(run.verdict.pass).toBe(false);
  expect(run.verdict.wordMatch.pass).toBe(true);
  expect(run.verdict.cutJoins).toMatchObject({ judged: true, failed: true, piecesChecked: 1,
    cuts: [{ piece: 1, of: 2, text: "Hello", reason: "tail-at-speech-level" }] });
}, 30_000);

test("check-take reports a faded join and rejects it only with --reject-fades", () => {
  const dir = take("fade-join", ["fade", "decay"], ["Hello", "moon"]);
  const measured = checkTake(dir);
  expect(measured.exitCode).toBe(0);
  expect(measured.verdict.cutJoins.fadeMeasurements[0]).toMatchObject({ piece: 1, detected: true });
  const strict = checkTake(dir, `${dir}/pieces`, true);
  expect(strict.exitCode).toBe(1);
  expect(strict.verdict.cutJoins.cuts[0].reason).toBe("fade-from-speech-level");
}, 30_000);

test("malformed kept-piece metadata exits 2 instead of allowing NaN to skip the match", () => {
  const cut = take("metadata-cut", ["cut", "decay"], ["Hello", "moon"]);
  const other = take("metadata-other", ["cut"], ["Hello"]);
  const file = `${other}/pieces/pieces.json`;
  const original = JSON.parse(readFileSync(file, "utf8"));
  for (const [field, value] of [["samples", undefined], ["samples", 0], ["durationSeconds", 0],
    ["durationSeconds", 1e300], ["offsetSeconds", -1], ["pauseAfterSeconds", null],
    ["offsetSamples", 1], ["pauseAfterSamples", -1], ["file", null], ["text", null]]) {
    const changed = structuredClone(original);
    changed.pieces[0][field as string] = value;
    writeFileSync(file, JSON.stringify(changed));
    expect(checkTake(cut, `${other}/pieces`).exitCode).toBe(2);
  }
  const clean = take("metadata-clean", ["decay", "decay"], ["Hello", "moon"]);
  const manifest = `${clean}/pieces/pieces.json`;
  const valid = JSON.parse(readFileSync(manifest, "utf8"));
  for (const mutate of [(x: typeof valid) => x.totalSamples++,
    (x: typeof valid) => x.pieces[1].offsetSeconds += 0.1,
    (x: typeof valid) => x.pieces[1].durationSeconds += 0.1]) {
    const changed = structuredClone(valid);
    mutate(changed);
    writeFileSync(manifest, JSON.stringify(changed));
    expect(checkTake(clean).exitCode).toBe(2);
  }
}, 30_000);

test("a clean pieced take and a one-piece take still pass", () => {
  for (const dir of [take("clean-join", ["decay", "decay"], ["Hello", "moon"]), take("one-piece", ["decay"], ["Hello"])]) {
    for (const pieces of [`${dir}/pieces`, null]) {
      const run = checkTake(dir, pieces);
      expect(run.exitCode).toBe(0);
      expect(run.verdict.pass).toBe(true);
    }
  }
}, 30_000);

test("joins are judged only with --pieces, say so plainly otherwise, and pieces must match the take", () => {
  const cut = take("cut-join", ["cut", "decay"], ["Hello", "moon"]), clean = take("clean-join", ["decay", "decay"], ["Hello", "moon"]);
  expect(checkTake(clean).verdict.cutJoins).toMatchObject({ judged: true, failed: false, piecesChecked: 1, cuts: [] });
  expect(checkTake(take("one-piece", ["decay"], ["Hello"])).verdict.cutJoins).toMatchObject({ judged: true, failed: false, piecesChecked: 0, cuts: [] });
  // Without --pieces a cut join is not passed silently: the JSON and stderr both say the joins were not judged.
  const blind = checkTake(cut, null);
  expect(blind.verdict.cutJoins).toMatchObject({ judged: false, failed: false, piecesChecked: 0 });
  expect(blind.verdict.cutJoins.note).toStartWith("joins not judged");
  expect(blind.stderr).toContain("joins not judged");
  expect(checkTake(clean).stderr).not.toContain("joins not judged");
  // Another take's pieces, a missing pieces.json and a bare --pieces are input errors.
  expect(checkTake(clean, `${ROOT}/one-piece/pieces`).exitCode).toBe(2);
  expect(checkTake(clean, ROOT).exitCode).toBe(2);
  expect(checkTake(clean, "").exitCode).toBe(2);
}, 30_000);

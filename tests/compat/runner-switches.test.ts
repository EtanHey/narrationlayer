import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { splitForBreathing } from "../../src/plan/breathing.js";
import { normalizeForSpeech } from "../../src/text-normalize.js";
import { computeContentHashKey } from "../../src/pipelines/local-tts/take-cache.js";
import { type DefaultsRender, defaultsProfile, defaultsText, fixture, measureWav, runner, runnerArgs, stderrClass } from "./harness.js";

// The two runner switches: --refresh-cache (re-roll a cached take in one step) and
// --keep-pieces <dir> (leave each joined piece behind). Neither is in the cache key.

type Fixture = Awaited<ReturnType<typeof fixture>>;
const out = (f: Fixture) => path.join(f.root, "out.wav");
const receipt = async (f: Fixture) => JSON.parse(await readFile(`${out(f)}.cache.json`, "utf8"));

/** The fixture tone at half amplitude: a different take for the same request. */
function quieter(wav: Buffer): Buffer {
  const copy = Buffer.from(wav);
  for (let at = 44; at + 1 < copy.length; at += 2) copy.writeInt16LE(copy.readInt16LE(at) >> 1, at);
  return copy;
}

function directKey(f: Fixture, text: string) {
  return computeContentHashKey({ spokenText: normalizeForSpeech(text), referenceClip: path.join(f.root, "reference.wav"), referenceText: "Synthetic reference.", params: {} });
}

test("--refresh-cache renders a new take and replaces the cached one", async () => {
  const f = await fixture();
  try {
    const args = runnerArgs(f, "Hello there");
    const cached = path.join(f.root, "cache", `${directKey(f, "Hello there")}.wav`);
    expect(stderrClass((await runner(f, args)).stderr)).toBe("ok");
    const first = await readFile(cached);

    f.setAudio(quieter(f.wav));
    // Without the switch the old take still wins.
    expect(stderrClass((await runner(f, args)).stderr)).toBe("cache HIT");
    expect((await readFile(out(f))).equals(first)).toBe(true);

    const refreshed = await runner(f, [...args, "--refresh-cache"]);
    expect(refreshed.code, refreshed.stderr).toBe(0);
    expect(refreshed.stderr).toContain("cache REFRESH->frozen");
    const second = await readFile(cached);
    expect(second.equals(first)).toBe(false);
    expect((await readFile(out(f))).equals(second)).toBe(true);
    expect(await receipt(f)).toEqual({ version: 1, cacheKey: directKey(f, "Hello there"), cacheEnabled: true, cacheRefreshed: true });
    expect(readdirSync(path.join(f.root, "cache"))).toEqual([path.basename(cached)]);

    // The next plain run replays the refreshed take.
    expect(stderrClass((await runner(f, args)).stderr)).toBe("cache HIT");
    expect((await readFile(out(f))).equals(second)).toBe(true);
  } finally { await f.close(); }
}, 30000);

test("a failed --refresh-cache keeps the old cache entry", async () => {
  const f = await fixture();
  try {
    const args = runnerArgs(f, "Hello there");
    const cached = path.join(f.root, "cache", `${directKey(f, "Hello there")}.wav`);
    expect((await runner(f, args)).code).toBe(0);
    const first = await readFile(cached);
    f.setMode("http");
    const failed = await runner(f, [...args, "--refresh-cache"]);
    expect(failed.code).not.toBe(0);
    expect((await readFile(cached)).equals(first)).toBe(true);
    expect(existsSync(`${out(f)}.cache.json`)).toBe(false);
  } finally { await f.close(); }
}, 30000);

test("--refresh-cache with --no-cache is refused before any request", async () => {
  const f = await fixture();
  try {
    for (const order of [["--refresh-cache", "--no-cache"], ["--no-cache", "--refresh-cache"]]) {
      const result = await runner(f, [...runnerArgs(f, "Hello there"), ...order]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--refresh-cache cannot be combined with --no-cache");
    }
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
}, 30000);

type PiecesJson = { version: number; totalSamples: number; pieces: { index: number; file: string; text: string; samples: number; durationSeconds: number; pauseAfterSamples: number; pauseAfterSeconds: number; offsetSamples: number; offsetSeconds: number }[] };

async function checkPieces(dir: string, final: string, texts: string[]) {
  const json: PiecesJson = JSON.parse(await readFile(path.join(dir, "pieces.json"), "utf8"));
  const files = texts.map((_, i) => `piece-${String(i).padStart(3, "0")}.wav`);
  expect(readdirSync(dir).sort()).toEqual([...files, "pieces.json"].sort());
  expect(json.pieces.map(p => p.text)).toEqual(texts);
  let offset = 0;
  for (const [i, piece] of json.pieces.entries()) {
    expect(piece.index).toBe(i);
    expect(piece.offsetSamples).toBe(offset);
    expect((await measureWav(path.join(dir, files[i]!))).samples).toBe(piece.samples);
    expect(piece.durationSeconds).toBe(piece.samples / 24000);
    if (i === json.pieces.length - 1) expect(piece.pauseAfterSamples).toBe(0);
    offset += piece.samples + piece.pauseAfterSamples;
  }
  const finalSamples = (await measureWav(final)).samples;
  expect(json.totalSamples).toBe(finalSamples);
  expect(offset).toBe(finalSamples);
  return json;
}

test("--keep-pieces writes each joined piece; pieces and pauses add up; the output is unchanged", async () => {
  const f = await fixture();
  try {
    const render = { sentence_pause_seconds: 0.41, comma_pause_seconds: 0.17, atempo: 1.25, loudness_target_db: -20 } as DefaultsRender;
    await defaultsProfile(f, render);
    const args = ["--text", defaultsText, "--output", out(f), "--reference", "compat-defaults", "--no-cache", "--timeout-ms", "10000"];
    expect((await runner(f, args)).code).toBe(0);
    const without = await readFile(out(f));
    const dir = path.join(f.root, "kept", "pieces");
    const kept = await runner(f, [...args, "--keep-pieces", dir]);
    expect(kept.code, kept.stderr).toBe(0);
    expect((await readFile(out(f))).equals(without)).toBe(true);
    const texts = splitForBreathing(normalizeForSpeech(defaultsText), 0.41, 0.17).map(p => p.text);
    expect(texts.length).toBeGreaterThan(1);
    const json = await checkPieces(dir, out(f), texts);
    expect(json.pieces.slice(0, -1).every(p => p.pauseAfterSamples > 0)).toBe(true);
    expect((await receipt(f)).keptPieces).toEqual({ dir, count: texts.length });
    // No log line carries the spoken text.
    for (const text of texts) expect(kept.stderr).not.toContain(text);
  } finally { await f.close(); }
}, 30000);

test("--keep-pieces on an uncut render keeps one piece", async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.root, "pieces");
    const result = await runner(f, [...runnerArgs(f, "Hello there"), "--no-cache", "--keep-pieces", dir]);
    expect(result.code, result.stderr).toBe(0);
    await checkPieces(dir, out(f), [normalizeForSpeech("Hello there")]);
  } finally { await f.close(); }
}, 30000);

test("--keep-pieces on a cache HIT writes none and says so", async () => {
  const f = await fixture();
  try {
    const args = runnerArgs(f, "Hello there");
    expect((await runner(f, args)).code).toBe(0);
    const before = f.requests.length;
    const dir = path.join(f.root, "pieces");
    const hit = await runner(f, [...args, "--keep-pieces", dir]);
    expect(hit.code, hit.stderr).toBe(0);
    expect(stderrClass(hit.stderr)).toBe("cache HIT");
    expect(hit.stderr).toContain("pieces=skipped");
    expect(f.requests.length).toBe(before);
    expect(existsSync(dir)).toBe(false);
    expect((await receipt(f)).keptPieces).toEqual({ dir, count: 0, skipped: "cache hit: no pieces were rendered" });
  } finally { await f.close(); }
}, 30000);

test("--keep-pieces refuses a non-empty directory and deletes nothing in it", async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.root, "pieces");
    await mkdir(dir);
    await writeFile(path.join(dir, "keep-me.txt"), "mine");
    const result = await runner(f, [...runnerArgs(f, "Hello there"), "--no-cache", "--keep-pieces", dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("must not exist or must be empty");
    expect(readdirSync(dir)).toEqual(["keep-me.txt"]);
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
}, 30000);

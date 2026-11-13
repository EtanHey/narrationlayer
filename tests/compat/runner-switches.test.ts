import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** Makes the cache directory read-only for `run`, so the runner's store fails for real (EACCES), then restores it. */
async function readOnlyCache<T>(f: Fixture, run: () => Promise<T>): Promise<T> {
  const dir = path.join(f.root, "cache");
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o555);
  try {
    // The precondition, checked: a process that ignores permissions (root) would make these tests vacuous.
    await expect(writeFile(path.join(dir, "probe"), "x")).rejects.toThrow();
    return await run();
  } finally { await chmod(dir, 0o755); }
}

test("a failed cache store on a plain MISS still succeeds, with the right output and its receipt", async () => {
  const f = await fixture();
  try {
    const args = runnerArgs(f, "Hello there");
    const key = directKey(f, "Hello there");
    const missed = await readOnlyCache(f, () => runner(f, args));
    expect(missed.code, missed.stderr).toBe(0);
    expect(missed.stderr).toContain(`cache MISS (store failed key=${key})`);
    expect(readdirSync(path.join(f.root, "cache"))).toEqual([]);
    const output = await readFile(out(f));
    expect(await receipt(f)).toEqual({ version: 1, cacheKey: key, cacheEnabled: true });
    expect(await readFile(`${out(f)}.spoken.txt`, "utf8")).toBe(normalizeForSpeech("Hello there"));
    // The right output: byte-identical to the same request whose store succeeds.
    const stored = await runner(f, args);
    expect(stored.stderr).toContain(`cache MISS->frozen key=${key}`);
    expect((await readFile(out(f))).equals(output)).toBe(true);
  } finally { await f.close(); }
}, 30000);

// PINNED, NOT APPROVED: a refresh whose store fails exits non-zero but has already written the new
// output and its spoken-text file, and writes no receipt beside them (the receipt comes after the store).
test("a failed cache store under --refresh-cache fails readably, keeps the old entry, and leaves output + spoken text with no receipt", async () => {
  const f = await fixture();
  try {
    const args = runnerArgs(f, "Hello there");
    const key = directKey(f, "Hello there");
    const cached = path.join(f.root, "cache", `${key}.wav`);
    expect((await runner(f, args)).code).toBe(0);
    const first = await readFile(cached);
    await rm(`${out(f)}.cache.json`);
    await rm(`${out(f)}.spoken.txt`);
    f.setAudio(quieter(f.wav));
    const failed = await readOnlyCache(f, () => runner(f, [...args, "--refresh-cache"]));
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(`--refresh-cache could not store the new take for key=${key}:`);
    expect((await readFile(cached)).equals(first)).toBe(true);
    expect(readdirSync(path.join(f.root, "cache"))).toEqual([path.basename(cached)]);
    // What the failed run leaves behind today:
    expect((await readFile(out(f))).equals(first)).toBe(false);
    expect(await readFile(`${out(f)}.spoken.txt`, "utf8")).toBe(normalizeForSpeech("Hello there"));
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
    // The pause is the profile's: comma after "First clause", sentence after "second clause.", none at the end.
    expect(texts).toEqual(["First clause", "second clause.", "Last sentence."]);
    expect(json.pieces.map(p => p.pauseAfterSeconds)).toEqual([0.17, 0.41, 0]);
    expect(json.pieces.map(p => p.pauseAfterSamples)).toEqual([0.17 * 24000, 0.41 * 24000, 0].map(Math.round));
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

/** A 24 kHz mono 16-bit tone: each piece gets its own amplitude and period, so wrong audio of the right length fails. */
function tone(amplitude: number, period: number, samples = 4800): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(i * 2 * Math.PI / period)), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
const pcmOf = async (file: string) => { const b = await readFile(file); return b.subarray(b.indexOf("data") + 8); };

test("--keep-pieces keeps the audio that was joined: each piece's own audio, processed, in order", async () => {
  const f = await fixture();
  try {
    // No loudness pass, so the final file IS the join and each piece can be found in it sample for sample.
    await defaultsProfile(f, { sentence_pause_seconds: 0.41, comma_pause_seconds: 0.17, atempo: 1.25 });
    const texts = splitForBreathing(normalizeForSpeech(defaultsText), 0.41, 0.17).map(p => p.text);
    const voices = new Map(texts.map((text, i) => [text, { amplitude: [3000, 9000, 18000][i]!, period: [20, 40, 80][i]! }]));
    f.setAudio(body => { const v = voices.get(body.text ?? ""); return v ? tone(v.amplitude, v.period) : f.wav; });
    const dir = path.join(f.root, "pieces");
    const result = await runner(f, ["--text", defaultsText, "--output", out(f), "--reference", "compat-defaults", "--no-cache", "--timeout-ms", "10000", "--keep-pieces", dir]);
    expect(result.code, result.stderr).toBe(0);
    const json = await checkPieces(dir, out(f), texts);
    const final = await pcmOf(out(f));
    const levels: number[] = [];
    for (const piece of json.pieces) {
      const kept = await pcmOf(path.join(dir, piece.file));
      // The kept piece is exactly the stretch of the joined file at its offset, and the pause after it is silence.
      expect(kept.equals(final.subarray(piece.offsetSamples * 2, (piece.offsetSamples + piece.samples) * 2))).toBe(true);
      const pause = final.subarray((piece.offsetSamples + piece.samples) * 2, (piece.offsetSamples + piece.samples + piece.pauseAfterSamples) * 2);
      expect(pause.every(byte => byte === 0)).toBe(true);
      // It is THIS piece's audio after atempo: its level matches the tone served for its text, not a neighbour's.
      levels.push((await measureWav(path.join(dir, piece.file))).rmsDb!);
    }
    const expected = [...voices.values()].map(v => 20 * Math.log10(v.amplitude / 32768 / Math.SQRT2));
    for (const [i, level] of levels.entries()) expect(Math.abs(level - expected[i]!)).toBeLessThan(1.5);
    // Each piece's audio is different from every other's (distinct by more than the 1.5 dB tolerance).
    expect(new Set(await Promise.all(json.pieces.map(async p => (await pcmOf(path.join(dir, p.file))).toString("base64")))).size).toBe(texts.length);
  } finally { await f.close(); }
}, 30000);

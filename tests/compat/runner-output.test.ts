import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { splitForBreathing } from "../../src/plan/breathing.js";
import { normalizeForSpeech } from "../../src/text-normalize.js";
import corpus from "./fixtures/corpus.json";
import { compatProfile, defaultsCases, type DefaultsRender, defaultsProfile, defaultsText, fixture, golden, measureWav, runner, runnerArgs, stderrClass, wrappers } from "./harness.js";

// What the runner WRITES, for the runs the executable and defaults goldens make (plus two
// tempo runs those goldens lack: every recorded run uses atempo 1 or none). The other goldens
// freeze requests and ffmpeg argv; a stage whose result never reaches out.wav leaves both
// unchanged. These measures move instead. They prove a stage's result reached the output;
// they do not judge how it sounds.
//
// Pinned: PCM format, exact sample count, RMS level (0.1 dB, compared within RMS_TOLERANCE_DB).
// Not pinned: a content hash. The hosted runner installs an unpinned ffmpeg, and the EQ,
// tempo and gain stages are floating-point filters whose exact samples may change between
// ffmpeg versions; the gain itself comes from volumedetect's printed measurement.
const RMS_TOLERANCE_DB = 0.3;
const SAMPLE_RATE = 24000;

type Run = { run: string; text: string; args: string[]; sentence?: number; comma?: number; atempo?: number };
type Measure = Awaited<ReturnType<typeof measureWav>> & { run: string };

/**
 * The sample count the pieces and pads imply. The stub returns the same tone for every
 * request; each speech segment is that tone, after atempo when set. Silence pads are exact;
 * ffmpeg's atempo is not (1.25 gives 3900 samples for 4800, ideal 3840), so each tempo-changed
 * segment allows 2% + 16 samples. The total tolerance stays below the smallest segment or pad,
 * so losing one of them still fails.
 */
function implied(run: Run, stubSamples: number) {
  const breathing = run.sentence !== undefined || run.comma !== undefined;
  const pieces = breathing ? splitForBreathing(normalizeForSpeech(run.text), run.sentence ?? 0.55, run.comma ?? 0.22) : [];
  const assembled = pieces.length >= 2;
  const segments = assembled ? pieces.length : 1;
  const pads = assembled ? pieces.slice(0, -1).map(piece => piece.padAfterSeconds).filter(pad => pad > 0).map(pad => Math.round(pad * SAMPLE_RATE)) : [];
  const segment = run.atempo === undefined ? stubSamples : stubSamples / run.atempo;
  const perSegment = run.atempo === undefined ? 0 : Math.ceil(segment * 0.02) + 16;
  const tolerance = segments * perSegment;
  expect(tolerance, `${run.run}: tolerance must stay below the smallest segment or pad`).toBeLessThan(Math.min(segment, ...pads));
  return { samples: Math.round(segments * segment + pads.reduce((sum, pad) => sum + pad, 0)), tolerance };
}

async function measureRuns(f: Awaited<ReturnType<typeof fixture>>, runs: Run[]) {
  const stubSamples = (f.wav.length - 44) / 2;
  const measures: Measure[] = [];
  for (const run of runs) {
    const result = await runner(f, run.args);
    expect(result.code, `${run.run}: ${result.stderr}`).toBe(0);
    // A cache HIT copies a frozen take and skips every stage; each run here must render.
    expect(stderrClass(result.stderr), `${run.run} must render, not replay the cache`).toBe("ok");
    const measure = { run: run.run, ...(await measureWav(path.join(f.root, "out.wav"))) };
    const expected = implied(run, stubSamples);
    expect(Math.abs(measure.samples - expected.samples), `${run.run}: output has ${measure.samples} samples; the pieces and pads imply ${expected.samples} ± ${expected.tolerance}`)
      .toBeLessThanOrEqual(expected.tolerance);
    measures.push(measure);
  }
  return measures;
}

/** Compares each run's measures with the pinned ones and names every run and measure that moved. */
async function outputGolden(name: string, measures: Measure[]) {
  if (process.env.UPDATE_COMPAT_GOLDENS === "1") return golden(name, { runs: measures });
  const pinned: Measure[] = JSON.parse(await readFile(path.join(import.meta.dir, "fixtures", `${name}.golden.json`), "utf8")).runs;
  expect(measures.map(m => m.run), `${name}: the set of runs changed`).toEqual(pinned.map(m => m.run));
  const moved: string[] = [];
  measures.forEach((now, i) => {
    const was = pinned[i];
    if (JSON.stringify(now.format) !== JSON.stringify(was.format)) moved.push(`${now.run}: format moved: pinned ${JSON.stringify(was.format)}, now ${JSON.stringify(now.format)}`);
    if (now.samples !== was.samples) moved.push(`${now.run}: samples moved: pinned ${was.samples}, now ${now.samples}`);
    if (now.rmsDb === null || was.rmsDb === null ? now.rmsDb !== was.rmsDb : Math.abs(now.rmsDb - was.rmsDb) > RMS_TOLERANCE_DB)
      moved.push(`${now.run}: rmsDb moved: pinned ${was.rmsDb}, now ${now.rmsDb} (tolerance ${RMS_TOLERANCE_DB} dB)`);
  });
  expect(moved, `${name}: the output audio moved\n${moved.join("\n")}`).toEqual([]);
}

test("runner output audio: executable corpus, direct and named profile", async () => {
  const f = await fixture();
  try {
    await wrappers(f.root); await compatProfile(f);
    const runs: Run[] = [];
    corpus.forEach((text, i) => {
      runs.push({ run: `corpus[${i}] direct`, text, args: runnerArgs(f, text) });
      // Same flags as the executable golden: the named profile's daemon and token win over them.
      runs.push({ run: `corpus[${i}] profile`, text, comma: 0.22, atempo: 1,
        args: [...runnerArgs(f, text, "compat-voice"), "--daemon-url", "http://127.0.0.1:1", "--auth-token-file", "missing-flag-token"] });
    });
    await outputGolden("runner-output-corpus", await measureRuns(f, runs));
  } finally { await f.close(); }
}, 60000);

// One fresh fixture per case: the `compat-defaults` profile carries the case's render fields.
type ProfileCase = { run: string; text: string; render: DefaultsRender };
async function measureProfileCases(cases: ProfileCase[]) {
  const measures: Measure[] = [];
  for (const { run, text, render } of cases) {
    const f = await fixture();
    try {
      await wrappers(f.root); await defaultsProfile(f, render);
      const args = ["--text", text, "--output", path.join(f.root, "out.wav"), "--reference", "compat-defaults",
        "--reference-text", "Synthetic reference.", "--cache-dir", path.join(f.root, "cache"), "--timeout-ms", "10000"];
      measures.push(...await measureRuns(f, [{ run, text, args, sentence: render.sentence_pause_seconds, comma: render.comma_pause_seconds, atempo: render.atempo }]));
    } finally { await f.close(); }
  }
  return measures;
}

test("runner output audio: defaults cases", async () => {
  const cases = defaultsCases.map(variant => ({ run: `defaults ${variant.name}`, text: defaultsText, render: variant.render }));
  await outputGolden("runner-output-defaults", await measureProfileCases(cases));
}, 60000);

// The recorded runs all use atempo 1, which keeps the sample count, so a dropped tempo result
// is invisible there. These runs use 1.25: standalone (no pauses set) and per breathing piece.
test("runner output audio: tempo 1.25, standalone and per breathing piece", async () => {
  await outputGolden("runner-output-tempo", await measureProfileCases([
    { run: "tempo-only single piece", text: "Hello", render: { atempo: 1.25 } },
    { run: "tempo-only several sentences", text: defaultsText, render: { atempo: 1.25 } },
    { run: "breathing with tempo", text: defaultsText, render: { sentence_pause_seconds: 0.41, comma_pause_seconds: 0.17, atempo: 1.25 } },
  ]));
}, 60000);

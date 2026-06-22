import { expect, test } from "bun:test";

import {
  buildMonoS16WavArgs,
  buildLoudnessNormalizeArgs,
  computeLoudnessGainDb,
  computeContentHashKey,
  splitForBreathing,
  type CacheKeyParams,
} from "../bin/local-tts-runner.js";

// An eq-bearing profile carries eq_highshelf_hz / eq_highshelf_gain_db, so
// qwenConfigFromProfile surfaces them and the runner must inject the de-muffle
// high-shelf filter into its single mono s16le pass.
test("eq-bearing config injects highshelf into the single ffmpeg pass", () => {
  const args = buildMonoS16WavArgs("/in.mp3", "/out.wav", 24000, {
    eqHighshelfHz: 4000,
    eqHighshelfGainDb: 8,
  });
  expect(args).toContain("-af");
  expect(args).toContain("highshelf=f=4000:g=8");
  // Exactly one pass: a single output path, single -i, no duplicate -c:a.
  expect(args.filter((a) => a === "-i").length).toBe(1);
  expect(args.filter((a) => a === "-af").length).toBe(1);
  expect(args[args.length - 1]).toBe("/out.wav");
});

// A profile with NO eq params yields undefined for both, so the runner must
// produce NO highshelf / no -af (behavior unchanged).
test("config without eq params produces NO highshelf and no -af", () => {
  const args = buildMonoS16WavArgs("/in.mp3", "/out.wav", 24000, {});
  expect(args).not.toContain("-af");
  expect(args.some((a) => a.startsWith("highshelf"))).toBe(false);
});

test("splitForBreathing keeps closing quotes with sentence terminators and preserves short first sentences", () => {
  const text =
    'You keep saying "gate." Etan\'s been hammering that word for weeks. What\'s the actual thesis here — why is a gate different from just writing down a rule?';

  expect(splitForBreathing(text, 0.42, 0)).toEqual([
    { text: 'You keep saying "gate."', padAfterSeconds: 0.42 },
    {
      text: "Etan's been hammering that word for weeks.",
      padAfterSeconds: 0.42,
    },
    {
      text: "What's the actual thesis here — why is a gate different from just writing down a rule?",
      padAfterSeconds: 0,
    },
  ]);

  expect(splitForBreathing(text, 0.42, 0.16).map((piece) => piece.text)).toEqual([
    'You keep saying "gate."',
    "Etan's been hammering that word for weeks.",
    "What's the actual thesis here",
    "why is a gate different from just writing down a rule?",
  ]);
});

test("only one eq param set still injects highshelf using defaults", () => {
  const onlyHz = buildMonoS16WavArgs("/in.mp3", "/out.wav", 24000, {
    eqHighshelfHz: 5000,
  });
  expect(onlyHz).toContain("highshelf=f=5000:g=0");

  const onlyGain = buildMonoS16WavArgs("/in.mp3", "/out.wav", 24000, {
    eqHighshelfGainDb: 6,
  });
  expect(onlyGain).toContain("highshelf=f=4000:g=6");
});

// With loudness_target_db: -24, the runner's 2-pass RMS normalize computes
// gainDb = target - measured, then re-encodes with volume + limiter.
test("computeLoudnessGainDb: gain is target minus measured (boost a quiet body)", () => {
  // A quiet body measured at -28.0 dB, target -24 => +4 dB boost.
  expect(computeLoudnessGainDb(-28.0, -24)).toBeCloseTo(4.0, 6);
  // A body louder than target gets attenuated.
  expect(computeLoudnessGainDb(-20.0, -24)).toBeCloseTo(-4.0, 6);
  // Already at target => zero gain.
  expect(computeLoudnessGainDb(-24.0, -24)).toBeCloseTo(0.0, 6);
});

test("buildLoudnessNormalizeArgs: second pass includes volume= and alimiter, keeps mono/s16le/rate", () => {
  const gainDb = computeLoudnessGainDb(-28.0, -24); // +4 dB
  const args = buildLoudnessNormalizeArgs("/in.wav", "/out.wav", 24000, gainDb);
  const afIdx = args.indexOf("-af");
  expect(afIdx).toBeGreaterThanOrEqual(0);
  const filter = args[afIdx + 1];
  expect(filter).toBe("volume=4dB,alimiter=limit=0.95");
  // mono / target rate / s16le preserved.
  expect(args).toContain("-ac");
  expect(args[args.indexOf("-ac") + 1]).toBe("1");
  expect(args).toContain("-ar");
  expect(args[args.indexOf("-ar") + 1]).toBe("24000");
  expect(args).toContain("-c:a");
  expect(args[args.indexOf("-c:a") + 1]).toBe("pcm_s16le");
  expect(args[args.length - 1]).toBe("/out.wav");
});

// The eq-only args-builder must NOT carry loudness; volume=/alimiter appear ONLY
// in the dedicated loudness pass (target set). EQ pass has no volume/alimiter.
test("eq pass never contains volume=/alimiter (loudness is a separate gated pass)", () => {
  const eqArgs = buildMonoS16WavArgs("/in.mp3", "/out.wav", 24000, {
    eqHighshelfGainDb: 6,
  });
  expect(eqArgs.some((a) => a.includes("volume="))).toBe(false);
  expect(eqArgs.some((a) => a.includes("alimiter"))).toBe(false);
});

// --- Content-hash freeze key (determinism layer) ---

const baseKeyInput = {
  spokenText: "We use sooper base for auth.",
  referenceClip: "/clips/host.wav",
  referenceText: "host reference transcript",
  params: {
    eqHighshelfHz: 4000,
    eqHighshelfGainDb: 8,
    loudnessTargetDb: -24,
    atempo: 0.95,
    sentencePauseSeconds: 0.55,
    commaPauseSeconds: 0.22,
  } as CacheKeyParams,
};

test("computeContentHashKey: stable — identical request yields the SAME sha256 hex key", () => {
  const a = computeContentHashKey(baseKeyInput);
  const b = computeContentHashKey({
    spokenText: baseKeyInput.spokenText,
    referenceClip: baseKeyInput.referenceClip,
    referenceText: baseKeyInput.referenceText,
    params: { ...baseKeyInput.params },
  });
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
});

test("computeContentHashKey: param order does not change the key", () => {
  const reordered: CacheKeyParams = {
    commaPauseSeconds: 0.22,
    atempo: 0.95,
    eqHighshelfGainDb: 8,
    loudnessTargetDb: -24,
    sentencePauseSeconds: 0.55,
    eqHighshelfHz: 4000,
  };
  expect(computeContentHashKey({ ...baseKeyInput, params: reordered })).toBe(
    computeContentHashKey(baseKeyInput),
  );
});

test("computeContentHashKey: a different synth param => a DIFFERENT key", () => {
  const base = computeContentHashKey(baseKeyInput);
  const atempoChanged = computeContentHashKey({
    ...baseKeyInput,
    params: { ...baseKeyInput.params, atempo: 0.9 },
  });
  const loudnessChanged = computeContentHashKey({
    ...baseKeyInput,
    params: { ...baseKeyInput.params, loudnessTargetDb: -20 },
  });
  expect(atempoChanged).not.toBe(base);
  expect(loudnessChanged).not.toBe(base);
});

test("computeContentHashKey: different text / reference clip / reference text => different key", () => {
  const base = computeContentHashKey(baseKeyInput);
  expect(
    computeContentHashKey({ ...baseKeyInput, spokenText: "different words." }),
  ).not.toBe(base);
  expect(
    computeContentHashKey({
      ...baseKeyInput,
      referenceClip: "/clips/expert.wav",
    }),
  ).not.toBe(base);
  expect(
    computeContentHashKey({
      ...baseKeyInput,
      referenceText: "a different transcript",
    }),
  ).not.toBe(base);
});

test("computeContentHashKey: omitting a param equals passing it undefined (absent === undefined)", () => {
  const withUndefined = computeContentHashKey({
    ...baseKeyInput,
    params: { ...baseKeyInput.params, atempo: undefined },
  });
  const withoutKey: CacheKeyParams = {
    eqHighshelfHz: 4000,
    eqHighshelfGainDb: 8,
    loudnessTargetDb: -24,
    sentencePauseSeconds: 0.55,
    commaPauseSeconds: 0.22,
  };
  expect(computeContentHashKey({ ...baseKeyInput, params: withoutKey })).toBe(
    withUndefined,
  );
});

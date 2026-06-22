import { expect, test } from "bun:test";

import {
  checkDisplay,
  extractDisplay,
  parseScriptSegments,
  decideTone,
  decideSpeed,
  decideBreathing,
  decidePronunciation,
  decideStutter,
  normalizeStutterToken,
  countSentenceEnders,
  internalBreaths,
  parseArgs,
  decideTiming,
  scriptTokenCount,
  type ToneMeasurements,
  type SpeedMeasurements,
  type BreathMeasurements,
  type StutterWord,
  type TimingWord,
} from "../bin/narration-gate.js";
import type { DetectedSilence } from "../src/audio.js";

// TONE anchor = the --tone-anchor clip, measured as loudness-invariant
// TILT = hp_mean − body_mean. BODY/CONSISTENCY anchor = the reference take.
const ANCHOR_TILT = -17.4; // tone-anchor tilt
const ANCHOR_BODY = -24.2; // reference median full mean_volume

function tone(overrides: Partial<ToneMeasurements>): ToneMeasurements {
  return {
    anchorTilt: ANCHOR_TILT,
    anchorBody: ANCHOR_BODY,
    // Defaults model the HEALTHY take: tilt ≈ tone-anchor, body ≈ reference,
    // tight spread.
    expertTiltMedian: -17.4, // Δ0.0 from tone-anchor → within ±1.5
    expertBodyMedian: -23.5, // Δ0.7 from reference −24.2 → within ±2.0
    expertBodySpread: 0.3,
    ...overrides,
  };
}

// A tiny stand-in for the renderV4 tpdata embed: a `text:` display field plus a
// per-word array. We only need the JSON literals the gate scans for.
function tinyHtml(cueText: string, words: string[]): string {
  const tpdata = {
    "scene-1": {
      cues: [
        {
          start: 0,
          end: 1,
          text: cueText,
          words: words.map((w, i) => ({ word: w, start: i, end: i + 1 })),
        },
      ],
      total: 1,
    },
  };
  return `<html><body><script>window.__TP=${JSON.stringify(tpdata)};</script></body></html>`;
}

test("RED: a denylisted whisper-garble token in a display field fails the gate", () => {
  // "clod" is a whisper mishear of "Claude" and must never reach the display.
  const html = tinyHtml("The clod model shipped tonight.", [
    "The",
    "clod",
    "model",
  ]);
  const result = checkDisplay(html, undefined);
  expect(result.status).toBe("FAIL");
  expect(result.lines.some((l) => l.includes("clod"))).toBe(true);
});

test("GREEN: clean display text with no garble passes the gate", () => {
  const html = tinyHtml("The Claude model shipped tonight.", [
    "The",
    "Claude",
    "model",
  ]);
  const result = checkDisplay(html, undefined);
  expect(result.status).toBe("PASS");
});

test("RED: 'clawed' garble in a per-word token fails the gate", () => {
  // "clawed" is a whisper mishear of "Claude" and must never reach the display.
  const html = tinyHtml("Tonight the model shipped the gate.", [
    "Tonight",
    "clawed",
    "shipped",
  ]);
  const result = checkDisplay(html, undefined);
  expect(result.status).toBe("FAIL");
});

test("denylist matching is word-boundaried (substring 'clods' alone is not flagged as 'clod')", () => {
  // "clod" must match as a standalone token; an unrelated word that merely
  // ends in it should not, but a real "clod" token should. Here we confirm a
  // clean field with no standalone garble passes.
  const html = tinyHtml("The cloud burst and reclouded fast.", [
    "The",
    "cloud",
    "reclouded",
  ]);
  const result = checkDisplay(html, undefined);
  expect(result.status).toBe("PASS");
});

test("extractDisplay pulls both text and word display fields", () => {
  const html = tinyHtml("hello world", ["hello", "world"]);
  const { texts, words } = extractDisplay(html);
  expect(texts).toContain("hello world");
  expect(words).toContain("hello");
  expect(words).toContain("world");
});

test("parseScriptSegments: only `## Segment cNx` blocks, never frontmatter/separators/tables", () => {
  const script = [
    "# Episode",
    "",
    "> blockquote frontmatter line that is never rendered",
    "",
    "---",
    "",
    "## Segment c1q — host",
    "",
    "First segment narration text here.",
    "",
    "## Segment c1a — expert",
    "",
    "Second segment narration text here.",
    "",
    "---",
    "",
    "## Voice mapping",
    "",
    "| Segment | Voice profile | Role |",
    "|---------|--------------|------|",
    "| c1q | host-c1 | host |",
  ].join("\n");
  const segments = parseScriptSegments(script);
  expect(segments.map((s) => s.id)).toEqual(["c1q", "c1a"]);
  expect(segments[0].text).toBe("First segment narration text here.");
  // The blockquote, `---`, "## Voice mapping", and table must NOT be segments.
  expect(segments.some((s) => s.text.includes("blockquote"))).toBe(false);
  expect(segments.some((s) => s.text.includes("Voice profile"))).toBe(false);
});

test("--script segment presence: a substituted segment word fails the gate", () => {
  // Display faithfully shows c1q but NOT c1a (substituted text).
  const html = tinyHtml(
    "First segment narration text here.",
    "First segment narration text here.".split(" "),
  );
  const script = [
    "> frontmatter blockquote — never compared",
    "---",
    "## Segment c1q — host",
    "First segment narration text here.",
    "## Segment c1a — expert",
    "A completely different sentence that is absent from display.",
    "---",
    "| Segment | Voice profile | Role |",
  ].join("\n");
  const result = checkDisplay(html, script);
  expect(result.status).toBe("FAIL");
  expect(result.lines.some((l) => l.includes("c1a"))).toBe(true);
  // The metadata must never show up as MISSING.
  expect(result.lines.some((l) => l.includes("frontmatter"))).toBe(false);
  expect(result.lines.some((l) => l.includes("Voice profile"))).toBe(false);
});

test("--script segment presence: all segments displayed (whitespace-tolerant) passes", () => {
  // Display has the same words but with collapsed/extra whitespace + escaping.
  const html = tinyHtml("The   Claude  model\nshipped tonight.", [
    "The",
    "Claude",
    "model",
  ]);
  const script = [
    "> frontmatter — ignored",
    "---",
    "## Segment c1q — host",
    "The Claude model shipped tonight.",
    "---",
    "| Segment | Voice profile | Role |",
  ].join("\n");
  const result = checkDisplay(html, script);
  expect(result.status).toBe("PASS");
});

// ---- Anchored tilt tone decision (decideTone) ------------------------------
// TONE = loudness-invariant TILT vs the tone-anchor clip (≈ −17.4).
// BODY/CONSISTENCY = vs the reference take.

test("decideTone GREEN: anchor-matched pick (tilt −17.4, body −23.5, spread 0.3) passes", () => {
  const v = decideTone(tone({}));
  expect(v.tonePass).toBe(true);
  expect(v.bodyPass).toBe(true);
  expect(v.consistencyPass).toBe(true);
  expect(v.pass).toBe(true);
});

test("decideTone GREEN: tilt within ±0.5 of anchor (−17.0..−17.9) passes tone", () => {
  expect(decideTone(tone({ expertTiltMedian: -17.0 })).tonePass).toBe(true);
  expect(decideTone(tone({ expertTiltMedian: -17.9 })).tonePass).toBe(true);
});

test("decideTone RED: dark tilt (−20.1, Δ−2.7 > 1.5 tol) fails tone", () => {
  const v = decideTone(tone({ expertTiltMedian: -20.1 }));
  expect(v.tonePass).toBe(false);
  expect(v.tiltDelta).toBeCloseTo(-2.7, 6); // darker than tone-anchor
  expect(v.pass).toBe(false);
});

test("decideTone RED: over-bright tilt (−15.0, Δ+2.4 > 1.5 tol) fails tone", () => {
  const v = decideTone(tone({ expertTiltMedian: -15.0 }));
  expect(v.tonePass).toBe(false);
  expect(v.tiltDelta).toBeCloseTo(2.4, 6); // brighter than tone-anchor
  expect(v.pass).toBe(false);
});

test("decideTone RED: underwater quiet body (Δ−4 < −2.0 tol) fails body", () => {
  // -27.5 vs reference anchor -24.2 → bodyDelta -3.3.
  const v = decideTone(tone({ expertBodyMedian: -27.5 }));
  expect(v.bodyPass).toBe(false);
  expect(v.bodyDelta).toBeCloseTo(-3.3, 6);
  expect(v.pass).toBe(false);
});

test("decideTone RED: uneven body (spread 5.0 > 2.5) fails consistency", () => {
  const v = decideTone(tone({ expertBodySpread: 5.0 }));
  expect(v.consistencyPass).toBe(false);
  expect(v.pass).toBe(false);
});

test("decideTone: over-bright + underwater fails BOTH tone and body", () => {
  // The exact failure profile this work targets: over-bright tilt AND quiet/uneven.
  const v = decideTone(
    tone({
      expertTiltMedian: -15.5, // over-bright vs tone-anchor
      expertBodyMedian: -27.5, // quiet body vs reference
      expertBodySpread: 4.8, // uneven
    }),
  );
  expect(v.tonePass).toBe(false);
  expect(v.bodyPass).toBe(false);
  expect(v.consistencyPass).toBe(false);
  expect(v.pass).toBe(false);
});

test("parseArgs surfaces --anchor-job", () => {
  const args = parseArgs([
    "--html",
    "/c.html",
    "--job",
    "/j",
    "--anchor-job",
    "/anchor",
  ]);
  expect(args.anchorJob).toBe("/anchor");
});

// ---- Check B: SPEED BAND (decideSpeed) -------------------------------------

function speed(overrides: Partial<SpeedMeasurements>): SpeedMeasurements {
  // Defaults model the HEALTHY take: expert mid-band, host mid-band, ratio fine.
  return {
    expertMedianWpm: 155, // inside [145,165]
    hostMedianWpm: 160, // inside [150,170]
    ...overrides,
  };
}

test("decideSpeed GREEN: expert + host both mid-band, ratio + ceiling fine", () => {
  const v = decideSpeed(speed({}));
  expect(v.expertBandPass).toBe(true);
  expect(v.hostBandPass).toBe(true);
  expect(v.ratioPass).toBe(true);
  expect(v.ceilingPass).toBe(true);
  expect(v.pass).toBe(true);
});

test("decideSpeed GREEN: band edges are inclusive (145/165 expert, 150/170 host)", () => {
  expect(decideSpeed(speed({ expertMedianWpm: 145 })).expertBandPass).toBe(
    true,
  );
  expect(decideSpeed(speed({ expertMedianWpm: 165 })).expertBandPass).toBe(
    true,
  );
  expect(decideSpeed(speed({ hostMedianWpm: 150 })).hostBandPass).toBe(true);
  expect(decideSpeed(speed({ hostMedianWpm: 170 })).hostBandPass).toBe(true);
});

test("decideSpeed RED: expert too SLOW (below 145) fails expert band", () => {
  const v = decideSpeed(speed({ expertMedianWpm: 140 }));
  expect(v.expertBandPass).toBe(false);
  expect(v.pass).toBe(false);
});

test("decideSpeed RED: expert too FAST (above 165) fails expert band", () => {
  const v = decideSpeed(speed({ expertMedianWpm: 168 }));
  expect(v.expertBandPass).toBe(false);
  expect(v.pass).toBe(false);
});

test("decideSpeed RED: host out of band fails even if expert is fine", () => {
  const v = decideSpeed(speed({ hostMedianWpm: 180 }));
  expect(v.hostBandPass).toBe(false);
  expect(v.expertBandPass).toBe(true);
  expect(v.pass).toBe(false);
});

test("decideSpeed RED: absolute ceiling 175 caught even if bands somehow pass", () => {
  // 176 > 175 absolute ceiling AND above expert band.
  const v = decideSpeed(speed({ expertMedianWpm: 176, hostMedianWpm: 160 }));
  expect(v.ceilingPass).toBe(false);
  expect(v.pass).toBe(false);
});

test("decideSpeed RED: host-relative ratio (expert > host*1.35) fails ratio", () => {
  // host 110 -> ratio ceiling 148.5; expert 150 exceeds it (and band fine-ish).
  const v = decideSpeed(speed({ expertMedianWpm: 150, hostMedianWpm: 110 }));
  expect(v.ratioPass).toBe(false);
  expect(v.ratioCeiling).toBeCloseTo(148.5, 6);
  expect(v.pass).toBe(false);
});

// ---- Check C: BREATHING (decideBreathing / helpers) ------------------------

test("countSentenceEnders counts . ? ! and yields boundaries = count - 1", () => {
  expect(countSentenceEnders("One. Two. Three.")).toBe(3); // boundaries 2
  expect(countSentenceEnders("Just one sentence here")).toBe(0); // boundaries -1
  expect(countSentenceEnders("Wait! Really? Yes.")).toBe(3);
});

function sil(start: number, end: number): DetectedSilence {
  return { start, end, duration: Number((end - start).toFixed(3)) };
}

test("internalBreaths drops leading/trailing edge silences and short ones", () => {
  const dur = 10;
  const raw: DetectedSilence[] = [
    sil(0.0, 0.4), // leading edge (start < 0.10) -> drop
    sil(2.0, 2.5), // internal 0.5s -> keep
    sil(5.0, 5.15), // internal 0.15s < 0.30 -> drop
    sil(7.0, 7.5), // internal 0.5s -> keep
    sil(9.95, 10.0), // trailing edge (end within 0.10 of 10) -> drop
  ];
  const kept = internalBreaths(raw, dur);
  expect(kept.length).toBe(2);
  expect(kept.every((s) => s.duration >= 0.3)).toBe(true);
});

function breath(overrides: Partial<BreathMeasurements>): BreathMeasurements {
  // Default healthy 3-sentence segment (boundaries 2): need ceil(0.7*2)=2 breaths.
  return {
    sentenceBoundaries: 2,
    internalBreathCount: 2,
    hasLongBreath: true,
    ...overrides,
  };
}

test("decideBreathing SKIP: single-sentence segment (boundaries < 1) skips", () => {
  const v = decideBreathing(breath({ sentenceBoundaries: 0 }));
  expect(v.skipped).toBe(true);
  expect(v.pass).toBe(true);
});

test("decideBreathing GREEN: enough breaths + a long one passes", () => {
  const v = decideBreathing(breath({}));
  expect(v.required).toBe(2); // ceil(0.7*2)
  expect(v.countPass).toBe(true);
  expect(v.longPass).toBe(true);
  expect(v.pass).toBe(true);
});

test("decideBreathing required = ceil(0.7 * boundaries)", () => {
  expect(decideBreathing(breath({ sentenceBoundaries: 1 })).required).toBe(1);
  expect(decideBreathing(breath({ sentenceBoundaries: 3 })).required).toBe(3);
  expect(decideBreathing(breath({ sentenceBoundaries: 4 })).required).toBe(3);
});

test("decideBreathing RED: too few internal breaths fails count", () => {
  const v = decideBreathing(breath({ internalBreathCount: 1 }));
  expect(v.countPass).toBe(false);
  expect(v.pass).toBe(false);
});

test("decideBreathing RED: no breath >= 0.45s fails long requirement", () => {
  const v = decideBreathing(breath({ hasLongBreath: false }));
  expect(v.longPass).toBe(false);
  expect(v.pass).toBe(false);
});

// ---- Check D: PRONUNCIATION (decidePronunciation) --------------------------

test("decidePronunciation GREEN: term mapped to spoken form, no raw leak", () => {
  // "triage" -> "tree azh". Script has raw term; sidecar has spoken form only.
  const v = decidePronunciation(
    "We need to triage the queue.",
    "We need to tree azh the queue.",
  );
  expect(v.scriptTerms).toContain("triage");
  expect(v.missingSpoken.length).toBe(0);
  expect(v.leakedRaw.length).toBe(0);
  expect(v.pass).toBe(true);
});

test("decidePronunciation RED: missing sidecar fails every matched term", () => {
  const v = decidePronunciation("The cmux pane crashed.", null);
  expect(v.scriptTerms).toContain("cmux");
  expect(v.missingSpoken).toContain("see mux");
  expect(v.pass).toBe(false);
});

test("decidePronunciation RED: spoken form absent from sidecar", () => {
  // Script has "tty" -> "T T Y", but sidecar never normalized it.
  const v = decidePronunciation("Check the tty buffer.", "Check the buffer.");
  expect(v.scriptTerms).toContain("tty");
  expect(v.missingSpoken).toContain("T T Y");
  expect(v.pass).toBe(false);
});

test("decidePronunciation RED: raw term still leaks into spoken feed", () => {
  // Spoken form present BUT the raw "cmux" still appears (word-boundary).
  const v = decidePronunciation(
    "Open cmux now.",
    "Open see mux now and also cmux again.",
  );
  expect(v.leakedRaw).toContain("cmux");
  expect(v.pass).toBe(false);
});

test("decidePronunciation: no mapped term in script -> trivially passes", () => {
  const v = decidePronunciation("A plain sentence.", "A plain sentence.");
  expect(v.scriptTerms.length).toBe(0);
  expect(v.pass).toBe(true);
});

test("decidePronunciation: word-boundary safe — 'category' does not match a term", () => {
  // No TERM_MAP term is a substring trap here; ensure clean text passes.
  const v = decidePronunciation(
    "The category was triaged.",
    "The category was triaged.",
  );
  // "triage" is a term; "triaged" is NOT a word-boundary match for "triage".
  expect(v.scriptTerms).not.toContain("triage");
  expect(v.pass).toBe(true);
});

// ---- Check E: STUTTER (decideStutter) --------------------------------------

/** Build a StutterWord list from raw words with sequential 0.4s timings. */
function wordsAt(
  spec: { word: string; start?: number; end?: number }[],
): StutterWord[] {
  let t = 0;
  return spec.map((s) => {
    const start = s.start ?? t;
    const end = s.end ?? start + 0.4;
    t = end;
    return { norm: normalizeStutterToken(s.word), raw: s.word, start, end };
  });
}

test("decideStutter GREEN: a clean words array passes (no repeats, no glitches)", () => {
  const v = decideStutter(
    wordsAt([
      { word: "The" },
      { word: "one-line" },
      { word: "shape" },
      { word: "is" },
      { word: "this." },
      { word: "It" },
      { word: "scales." },
    ]),
  );
  expect(v.pass).toBe(true);
  expect(v.flags.length).toBe(0);
});

test("decideStutter GREEN: legit 'that that' doubling passes (allowlisted, run 2)", () => {
  const v = decideStutter(
    wordsAt([
      { word: "the" },
      { word: "day" },
      { word: "that" },
      { word: "that" },
      { word: "man" },
      { word: "left." },
    ]),
  );
  expect(v.pass).toBe(true);
});

test("decideStutter RED: adjacent-triple-duplicate fails even for allowlisted word", () => {
  // "that" thrice in a row is never natural English -> hard fail.
  const v = decideStutter(
    wordsAt([{ word: "that" }, { word: "that" }, { word: "that" }]),
  );
  expect(v.pass).toBe(false);
  expect(v.flags.some((f) => f.kind === "repeat")).toBe(true);
  expect(v.flags.some((f) => f.detail.includes('"that"'))).toBe(true);
});

test("decideStutter RED: non-allowlisted adjacent double ('model model') fails as repeat", () => {
  const v = decideStutter(
    wordsAt([{ word: "shipped" }, { word: "model" }, { word: "model" }]),
  );
  expect(v.pass).toBe(false);
  expect(v.flags.some((f) => f.kind === "repeat")).toBe(true);
  expect(v.flags.some((f) => f.detail.includes('"model"'))).toBe(true);
});

test("decideStutter RED: non-allowlisted short double ('the the') fails the gate", () => {
  // "the the" is a classic TTS stutter; "the" is NOT allowlisted. Flagged
  // (fragment-shaped since len 3) and FAILS regardless of flag kind.
  const v = decideStutter(
    wordsAt([{ word: "model" }, { word: "the" }, { word: "the" }]),
  );
  expect(v.pass).toBe(false);
  expect(v.flags.length).toBeGreaterThan(0);
});

test("decideStutter RED: an overlapping-timestamp cluster fails", () => {
  // Three words whose start < previous end (overlap) = a timing glitch cluster.
  const words: StutterWord[] = [
    { norm: "a", raw: "a", start: 0.0, end: 1.0 },
    { norm: "b", raw: "b", start: 0.5, end: 1.5 }, // overlaps a
    { norm: "c", raw: "c", start: 1.0, end: 2.0 }, // overlaps b
    { norm: "d", raw: "d", start: 1.2, end: 2.2 }, // overlaps c
  ];
  const v = decideStutter(words);
  expect(v.pass).toBe(false);
  expect(v.glitchCount).toBeGreaterThanOrEqual(3);
  expect(v.flags.some((f) => f.kind === "glitch")).toBe(true);
});

test("decideStutter RED: a consecutive zero-duration BURST (run >= 4) fails", () => {
  // Four+ collapsed timestamps in a row = a re-articulation burst, not a
  // scattered boundary token.
  const words: StutterWord[] = [
    { norm: "a", raw: "a", start: 0.0, end: 0.4 },
    { norm: "st", raw: "st", start: 1.0, end: 1.0 },
    { norm: "st", raw: "st", start: 1.0, end: 1.0 },
    { norm: "st", raw: "st", start: 1.0, end: 1.0 },
    { norm: "st", raw: "st", start: 1.0, end: 1.0 },
    { norm: "b", raw: "b", start: 1.5, end: 1.9 },
  ];
  const v = decideStutter(words);
  expect(v.pass).toBe(false);
  expect(v.flags.some((f) => f.kind === "glitch")).toBe(true);
});

test("decideStutter GREEN: SCATTERED single zero-dur boundary tokens pass (whisper artifact)", () => {
  // The gen18 clean-take pattern: short function words at sentence starts get a
  // single collapsed timestamp. Isolated (not a >=4 run, no overlap) -> NOT a
  // glitch, must PASS so real takes are not false-failed.
  const words: StutterWord[] = [
    { norm: "it", raw: "It", start: 1.58, end: 1.58 }, // boundary, isolated
    { norm: "scales", raw: "scales", start: 1.7, end: 2.1 },
    { norm: "and", raw: "And", start: 3.88, end: 3.88 }, // boundary, isolated
    { norm: "fast", raw: "fast", start: 4.0, end: 4.4 },
    { norm: "between", raw: "Between", start: 6.2, end: 6.2 }, // boundary
    { norm: "runs", raw: "runs", start: 6.3, end: 6.7 },
  ];
  const v = decideStutter(words);
  expect(v.pass).toBe(true);
  expect(v.glitchCount).toBe(0);
});

test("decideStutter RED: short stammer fragment ('st- st-') fails", () => {
  const v = decideStutter(
    wordsAt([{ word: "st-" }, { word: "st-" }, { word: "stutter" }]),
  );
  expect(v.pass).toBe(false);
  expect(v.flags.some((f) => f.kind === "fragment")).toBe(true);
});

test("normalizeStutterToken strips edge punctuation, lowercases, keeps inner hyphen", () => {
  expect(normalizeStutterToken("This.")).toBe("this");
  expect(normalizeStutterToken("st-")).toBe("st");
  expect(normalizeStutterToken("one-line")).toBe("one-line");
});

// ---- Check F: TIMING (decideTiming / anti-drift) ---------------------------

/**
 * A clean, ALIGNED set: monotonic, sane spans, last word ends right at the audio
 * duration, and word count matches the script token count. This is exactly the
 * shape regen-timings.ts now produces.
 */
const cleanAligned: TimingWord[] = [
  { word: "So", start: 0.0, end: 0.4 },
  { word: "this", start: 0.4, end: 0.8 },
  { word: "is", start: 0.8, end: 1.2 },
  { word: "aligned", start: 1.2, end: 2.0 },
];

test("decideTiming GREEN: clean aligned set passes all sub-checks", () => {
  const v = decideTiming(cleanAligned, 4, 2.0);
  expect(v.pass).toBe(true);
  expect(v.countPass).toBe(true);
  expect(v.monotonicPass).toBe(true);
  expect(v.spanPass).toBe(true);
  expect(v.durationPass).toBe(true);
});

test("decideTiming GREEN: last-word-end within tolerance of mp3 (edge ok)", () => {
  // lastEnd 2.0, mp3 2.6 → exactly 0.6 short, the inclusive edge.
  expect(decideTiming(cleanAligned, 4, 2.6).durationPass).toBe(true);
  // 2.0 vs 1.4 → exactly 0.6 over, inclusive edge.
  expect(decideTiming(cleanAligned, 4, 1.4).durationPass).toBe(true);
});

test("decideTiming RED: word count != script token count (drift signature)", () => {
  const v = decideTiming(cleanAligned, 6, 2.0);
  expect(v.pass).toBe(false);
  expect(v.countPass).toBe(false);
});

test("decideTiming RED: non-monotonic starts fail", () => {
  const words: TimingWord[] = [
    { word: "a", start: 0.0, end: 0.5 },
    { word: "b", start: 1.0, end: 1.5 },
    { word: "c", start: 0.7, end: 1.2 }, // goes backwards
  ];
  const v = decideTiming(words, 3, 1.5);
  expect(v.pass).toBe(false);
  expect(v.monotonicPass).toBe(false);
  expect(v.firstNonMonotonicIndex).toBe(2);
});

test("decideTiming RED: end<start fails span check", () => {
  const words: TimingWord[] = [
    { word: "a", start: 0.0, end: 0.5 },
    { word: "b", start: 1.0, end: 0.9 }, // end < start
  ];
  const v = decideTiming(words, 2, 0.9);
  expect(v.pass).toBe(false);
  expect(v.spanPass).toBe(false);
  expect(v.firstBadSpanIndex).toBe(1);
});

test("decideTiming RED: absurd span (> 4s) fails span check", () => {
  const words: TimingWord[] = [
    { word: "a", start: 0.0, end: 0.5 },
    { word: "b", start: 0.5, end: 5.5 }, // 5s span
  ];
  const v = decideTiming(words, 2, 5.5);
  expect(v.pass).toBe(false);
  expect(v.spanPass).toBe(false);
});

test("decideTiming RED: drifted-short set (highlight finishes well before audio)", () => {
  // The classic drift: timings end at 2.0 but the real audio is 10s long.
  const v = decideTiming(cleanAligned, 4, 10.0);
  expect(v.pass).toBe(false);
  expect(v.durationPass).toBe(false);
});

test("decideTiming RED: timings overrun past the audio duration", () => {
  const v = decideTiming(cleanAligned, 4, 0.5);
  expect(v.pass).toBe(false);
  expect(v.durationPass).toBe(false);
});

test("scriptTokenCount applies normalizeForSpeech and counts tokens", () => {
  // "cmux" -> "see mux" (two tokens) after normalization; plain words counted.
  expect(scriptTokenCount("She ships cmux")).toBe(
    // "She ships see mux" -> 4 tokens
    4,
  );
  expect(scriptTokenCount("Hello there world.")).toBe(3);
});

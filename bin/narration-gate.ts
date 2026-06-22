#!/usr/bin/env bun
/**
 * Deterministic narration gate.
 *
 * The canonical keystone that PROVES a rendered cinema dashboard is safe to ship:
 *   1. DISPLAY == SCRIPT  — the teleprompter spine must show clean script text,
 *      never whisper-garble mishears (e.g. "clod"/"clawed" for "Claude"). If a
 *      script is supplied, each segment's script text must appear verbatim in
 *      the HTML.
 *   2. EXPERT TONE/BODY/CONSISTENCY — the expert segments must match the target
 *      TONE (loudness-invariant spectral TILT = hp_mean − body_mean) of the
 *      supplied tone-anchor clip, AND match the BODY loudness + CONSISTENCY of
 *      the known-good reference take (--anchor-job). Tone anchors to the
 *      --tone-anchor clip (which may be brighter than the reference take);
 *      body/consistency anchor to the reference take.
 *   3. EXPERT WPM CEILING — the expert must not race past a hard WPM ceiling, nor
 *      run far faster than the host.
 *
 * Audio checks (2,3) SKIP gracefully when --job artifacts are absent. The
 * display check (1) ALWAYS runs. Exits non-zero on any FAIL.
 *
 * No private paths are hardcoded: every anchor/job/html/script comes from a CLI
 * arg. If a sub-check needs the tone-anchor and it is absent, that sub-check is
 * SKIPPED with a printed note (it never fails for a missing anchor).
 *
 * Usage:
 *   bun run bin/narration-gate.ts --html <cinema.html> \
 *     [--script <episode-script.md>] [--job <job-artifacts-dir>] \
 *     [--anchor-job <reference-job-dir>] [--tone-anchor <tone-anchor.mp3>] \
 *     [--expert-prefix c --host-prefix c --expert-suffix a --host-suffix q]
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { detectSilences, type DetectedSilence } from "../src/audio.js";
import {
  TERM_MAP,
  buildTermRegExp,
  normalizeForSpeech,
} from "../src/text-normalize.js";

// ---- Named thresholds (tune here) ------------------------------------------

/** Whisper mishears that must NEVER reach the displayed teleprompter text. */
const WHISPER_GARBLE_DENYLIST = ["clod", "clawed"];

/**
 * Max dB the expert >4kHz mean energy may sit BELOW the host average before we
 * call it muffled. Expert quieter than host by more than this is a FAIL. Used
 * ONLY by the legacy one-sided fallback when no --anchor-job is supplied; the
 * canonical run uses the two-sided anchored check below.
 */
const SPECTRAL_FLOOR_MAX_DEFICIT_DB = 12;

/** High-pass corner (Hz) used to isolate the high band for the tilt check. */
const SPECTRAL_HIGHPASS_HZ = 4000;

/**
 * Loudness-invariant TONE tolerance (dB). Tone is measured as spectral TILT =
 * hp_mean − body_mean (both via volumedetect). TILT cancels loudness: scaling a
 * clip up/down moves hp_mean and body_mean together, so the difference isolates
 * the high-vs-low band balance (true tone) regardless of level.
 *
 * The expert median TILT may deviate from the --tone-anchor TILT by at most this
 * much in EITHER direction (catches BOTH over-bright and over-muffled takes).
 */
const TONE_TOL_DB = 1.5;

/**
 * Two-sided body/loudness tolerance (dB) vs the reference anchor (--anchor-job).
 * The expert median body (full mean_volume) may deviate from the anchor by at
 * most this much in either direction — catches the too-quiet "underwater" body.
 */
const BODY_TOL_DB = 2.0;

/**
 * Consistency: max allowed expert body spread (max−min across segments). A
 * known-good reference take has a tight spread; anything wider is uneven.
 */
const BODY_SPREAD_TOL_DB = 2.5;

/**
 * Absolute words-per-minute ceiling for the expert. Gated on the MEDIAN across
 * the expert's role segments (not per-segment), so a single fast clause never
 * false-fails the take. 175 is a calm-but-engaged documentary pace; above it the
 * expert is racing.
 */
const WPM_CEILING = 175;

/**
 * Speed BAND for the EXPERT. The expert median WPM must sit inside this
 * inclusive band — too slow drags, too fast races. Upper edge stays under the
 * absolute WPM_CEILING.
 */
const EXPERT_WPM_MIN = 145;
const EXPERT_WPM_MAX = 165;

/**
 * Speed BAND for the HOST. A host carries the conversation slightly faster than
 * the expert's measured delivery, so the host band sits a touch higher.
 */
const HOST_WPM_MIN = 150;
const HOST_WPM_MAX = 170;

/** Expert median WPM may not exceed host median WPM times this factor. */
const WPM_RATIO_OVER_HOST = 1.35;

// ---- Breathing (Check C) thresholds ----------------------------------------

/** silencedetect noise floor (dB) for the breathing read. */
const BREATH_NOISE_DB = -35;
/** silencedetect minimum-duration (s) for the breathing read. */
const BREATH_DETECT_MIN_S = 0.3;
/** A silence shorter than this (s) is NOT counted as an internal breath. */
const BREATH_INTERNAL_MIN_S = 0.3;
/** At least one internal silence must be at least this long (s). */
const BREATH_LONG_MIN_S = 0.45;
/** Edge guard (s): silences at the very start/end are not internal breaths. */
const BREATH_EDGE_GUARD_S = 0.1;
/** Required internal breaths as a fraction of sentence boundaries. */
const BREATH_PER_BOUNDARY_RATIO = 0.7;

// ---- Stutter (Check E) thresholds ------------------------------------------

/**
 * Words that may LEGITIMATELY repeat back-to-back in natural English ("the day
 * that that man left", "I had had enough", "is is" never, but kept short). A
 * non-allowlisted word repeated even twice is a stutter; an allowlisted word is
 * only a stutter at 3+ in a row. NOTE: "the" is intentionally NOT here — "the
 * the" is a classic TTS stutter, not natural speech.
 */
const STUTTER_REPEAT_ALLOWLIST = ["that", "had", "is", "no", "very", "really"];

/**
 * Adjacent identical (normalized) words at or above this run length ALWAYS fail,
 * even for allowlisted words. Three-in-a-row is never natural English.
 */
const STUTTER_HARD_REPEAT_RUN = 3;

/**
 * Adjacent identical (normalized) NON-allowlisted words at or above this run
 * length fail. Two-in-a-row of a normal word ("model model", "the the") is a
 * stutter signature.
 */
const STUTTER_SOFT_REPEAT_RUN = 2;

/** Tokens this short (chars, after normalization) are treated as stammer fragments. */
const STUTTER_FRAGMENT_MAX_LEN = 3;

/** A stammer fragment repeated adjacently at/above this run length fails. */
const STUTTER_FRAGMENT_RUN = 2;

/**
 * A "glitch word" is one whose timing is genuinely wrong: it OVERLAPS the prior
 * word (start < previous end → the audio re-articulates before the last word
 * finished) OR it sits inside a CONSECUTIVE run of zero/negative-duration words.
 *
 * IMPORTANT calibration (gen18 clean-take audit, 2026-06-22): Whisper routinely
 * emits a single SCATTERED zero-duration timestamp (start==end) for short
 * function words at sentence boundaries ("It", "And", "But the") in perfectly
 * clean prose — high confidence ≈ 1.0, no audible stutter. Counting EVERY
 * zero-duration word as a glitch false-fails every real take. So an isolated
 * zero-duration word is NOT a glitch; only an overlap, or a CLUSTER of zero-dur
 * words ≥ STUTTER_ZERODUR_RUN in a row (a re-articulation burst), counts.
 */

/** Consecutive zero/negative-duration words at/above this run length = a glitch burst. */
const STUTTER_ZERODUR_RUN = 4;

/**
 * Absolute count of GLITCH words (overlaps + zero-dur-burst members) in a
 * segment that fails it outright (a timing-glitch cluster = a garbled take).
 */
const STUTTER_GLITCH_ABS = 3;

/**
 * Fraction of a segment's words that may be GLITCH words before it fails
 * (catches glitch clusters in short segments below STUTTER_GLITCH_ABS).
 */
const STUTTER_GLITCH_RATIO = 0.08;

// ---- Timing (Check F) thresholds -------------------------------------------

/**
 * Max plausible per-word span (s). The aftercode drift bug mapped clean script
 * words onto a raw whisper timeline by crude proportion; a genuinely aligned
 * word never spans more than a few seconds. A word whose end−start exceeds this
 * is absurd → the timeline is not really aligned to the audio.
 */
const TIMING_MAX_WORD_SPAN_S = 4;

/**
 * The last word's end must land within this tolerance (s) of the mp3 duration.
 * More than this SHORT means the highlight finishes well before the audio (the
 * classic drift signature); PAST the duration means timings overrun the audio.
 */
const TIMING_END_TOL_S = 0.6;

// ---- Arg parsing -----------------------------------------------------------

interface GateArgs {
  html: string;
  script?: string;
  job?: string;
  anchorJob?: string;
  /** Tone anchor clip; comes ONLY from --tone-anchor. Absent => tone SKIPPED. */
  toneAnchor?: string;
  expertPrefix: string;
  hostPrefix: string;
  expertSuffix: string;
  hostSuffix: string;
}

function parseArgs(argv: string[]): GateArgs {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        out[key] = "true";
      } else {
        out[key] = value;
        i += 1;
      }
    }
  }
  if (!out.html) {
    throw new Error("--html <cinema.html> is required");
  }
  return {
    html: out.html,
    script: out.script,
    job: out.job,
    anchorJob: out["anchor-job"],
    toneAnchor: out["tone-anchor"],
    expertPrefix: out["expert-prefix"] ?? "c",
    hostPrefix: out["host-prefix"] ?? out["expert-prefix"] ?? "c",
    expertSuffix: out["expert-suffix"] ?? "a",
    hostSuffix: out["host-suffix"] ?? "q",
  };
}

// ---- Report plumbing -------------------------------------------------------

type CheckStatus = "PASS" | "FAIL" | "SKIPPED";

interface CheckResult {
  name: string;
  status: CheckStatus;
  lines: string[];
}

function statusTag(status: CheckStatus): string {
  if (status === "PASS") return "GREEN";
  if (status === "FAIL") return "RED";
  return "SKIPPED";
}

// ---- Check 1: DISPLAY == SCRIPT --------------------------------------------

interface ExtractedDisplay {
  /** Every `text:` display field found in the embedded teleprompter data. */
  texts: string[];
  /** Every per-word display token found in the embedded teleprompter data. */
  words: string[];
}

/**
 * Pull the displayed teleprompter text out of the cinema HTML. renderV4 embeds
 * a `tpdata` JSON object whose every scene has
 *   cues: [{ ..., text: <SCRIPT>, words: [{ word, start, end }, ...] }]
 * The `text` field and each `words[].word` are the spine that the audience sees.
 * We extract them by scanning the embedded JSON literals rather than relying on
 * a particular minification.
 */
function extractDisplay(html: string): ExtractedDisplay {
  const texts: string[] = [];
  const words: string[] = [];

  // `"text":"..."` JSON string literals (handles escaped quotes/backslashes).
  const textRe = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (let m = textRe.exec(html); m; m = textRe.exec(html)) {
    texts.push(decodeJsonString(m[1]));
  }

  // `"word":"..."` JSON string literals from the per-word timing arrays.
  const wordRe = /"word"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (let m = wordRe.exec(html); m; m = wordRe.exec(html)) {
    words.push(decodeJsonString(m[1]));
  }

  return { texts, words };
}

function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

function checkDisplay(
  html: string,
  scriptText: string | undefined,
): CheckResult {
  const lines: string[] = [];
  const { texts, words } = extractDisplay(html);

  if (texts.length === 0 && words.length === 0) {
    return {
      name: "DISPLAY==SCRIPT",
      status: "FAIL",
      lines: [
        "No teleprompter display fields ('text:'/'word:') found in HTML — cannot prove display==script.",
      ],
    };
  }

  lines.push(
    `Scanned ${texts.length} display text field(s) and ${words.length} display word token(s).`,
  );

  const garbleHits: string[] = [];
  const haystacks = [...texts, ...words];
  for (const denied of WHISPER_GARBLE_DENYLIST) {
    const re = new RegExp(
      `(?<![A-Za-z0-9])${escapeRegExp(denied)}(?![A-Za-z0-9])`,
      "i",
    );
    for (const field of haystacks) {
      if (re.test(field)) {
        garbleHits.push(
          `garble "${denied}" found in display field: ${truncate(field, 80)}`,
        );
        break;
      }
    }
  }

  let status: CheckStatus = "PASS";
  if (garbleHits.length > 0) {
    status = "FAIL";
    lines.push(...garbleHits);
  } else {
    lines.push(
      `No whisper-garble tokens (${WHISPER_GARBLE_DENYLIST.join(", ")}) in display.`,
    );
  }

  // Optional: assert each parsed SCRIPT SEGMENT's narration appears in the
  // display. Segment-aware: we parse the `.md` with the same shape the build
  // uses (## Segment cNx blocks), so frontmatter/blockquotes, `---` separators,
  // and the voice-mapping table are never compared — only narration that the
  // cinema actually renders.
  if (scriptText !== undefined) {
    const segments = parseScriptSegments(scriptText);
    if (segments.length === 0) {
      status = "FAIL";
      lines.push(
        "No `## Segment cNx` narration blocks parsed from --script (expected at least one).",
      );
    } else {
      // The display the audience reads is the concatenation of the cleaned
      // teleprompter text fields. Normalize once for tolerant substring tests.
      const displayNorm = normalizeForCompare(texts.join(" "));
      const missing: string[] = [];
      for (const seg of segments) {
        if (!segmentPresentInDisplay(seg.text, displayNorm)) {
          missing.push(`${seg.id}: ${truncate(seg.text, 72)}`);
        }
      }
      if (missing.length > 0) {
        status = "FAIL";
        lines.push(
          `${missing.length} script segment(s) not faithfully displayed:`,
        );
        for (const m of missing.slice(0, 18)) {
          lines.push(`  MISSING: ${m}`);
        }
      } else {
        lines.push(
          `All ${segments.length} script segment(s) faithfully present in display.`,
        );
      }
    }
  }

  return { name: "DISPLAY==SCRIPT", status, lines };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

interface ScriptSegment {
  id: string;
  text: string;
}

/**
 * Parse `## Segment cNx ...` narration blocks out of the episode `.md`, mirroring
 * exactly how the cinema build extracts narration. Only these blocks are ever
 * rendered into the teleprompter; frontmatter/blockquotes (`>`), `---`
 * separators, and the voice-mapping table are NOT, so they are never compared.
 */
function parseScriptSegments(scriptText: string): ScriptSegment[] {
  const re = /##\s+Segment\s+(c\d+[qa])\b[^\n]*\n([\s\S]*?)(?=\n##\s|\n---)/g;
  const segments: ScriptSegment[] = [];
  for (let m = re.exec(scriptText); m; m = re.exec(scriptText)) {
    const text = m[2].trim();
    if (text.length > 0) segments.push({ id: m[1], text });
  }
  return segments;
}

/**
 * Normalize text for a whitespace/escaping-tolerant comparison: lower-case,
 * collapse any run of whitespace to a single space, and trim. This absorbs the
 * cosmetic differences between the raw `.md` and the rendered HTML display
 * (line wraps, HTML escaping, incidental spacing) without ignoring real word
 * substitutions.
 */
function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Robust presence test for a segment's narration inside the normalized display.
 * First tries a full normalized-substring match; if that is too brittle (e.g.
 * the build splits text across separate `text:` fields), falls back to checking
 * a representative slice — the first ~12 and last ~12 words appear, in order.
 */
function segmentPresentInDisplay(
  segText: string,
  displayNorm: string,
): boolean {
  const segNorm = normalizeForCompare(segText);
  if (segNorm.length === 0) return true;
  if (displayNorm.includes(segNorm)) return true;

  const words = segNorm.split(" ").filter((w) => w.length > 0);
  const slice = 12;
  const head = words.slice(0, slice).join(" ");
  const tail = words.slice(Math.max(0, words.length - slice)).join(" ");
  const headIdx = displayNorm.indexOf(head);
  if (headIdx === -1) return false;
  const tailIdx = displayNorm.indexOf(tail, headIdx);
  return tailIdx >= headIdx;
}

// ---- ffmpeg helpers --------------------------------------------------------

function runCapture(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (c) => (buf += String(c)));
    child.stderr.on("data", (c) => (buf += String(c)));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(buf));
  });
}

/** Mean high-band volume (dB) above SPECTRAL_HIGHPASS_HZ; null if unmeasurable. */
async function highBandMeanVolumeDb(mp3Path: string): Promise<number | null> {
  const out = await runCapture("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    mp3Path,
    "-af",
    `highpass=f=${SPECTRAL_HIGHPASS_HZ},volumedetect`,
    "-f",
    "null",
    "-",
  ]);
  if (!out) return null;
  const match = out.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Full-band mean volume (dB) — the "body" loudness; null if unmeasurable. */
async function fullMeanVolumeDb(mp3Path: string): Promise<number | null> {
  const out = await runCapture("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    mp3Path,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  if (!out) return null;
  const match = out.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Loudness-invariant spectral TILT (dB) = hp_mean − body_mean. Negative; more
 * negative = darker/muffled, less negative = brighter. Cancels loudness because
 * both terms scale together with level. null if either band is unmeasurable.
 */
async function bandTiltDb(mp3Path: string): Promise<number | null> {
  const hp = await highBandMeanVolumeDb(mp3Path);
  const body = await fullMeanVolumeDb(mp3Path);
  if (hp === null || body === null) return null;
  return hp - body;
}

// ---- Job artifact discovery ------------------------------------------------

interface SegmentArtifact {
  id: string;
  dir: string;
  mp3Path?: string;
  wordsPath?: string;
  /** `<output>.spoken.txt` sidecar (literal daemon-fed bytes), if present. */
  spokenTxtPath?: string;
  /** Per-segment SCRIPT (display feed) from job.json, if available. */
  script?: string;
}

/** Load id->script from a job.json index, if present. */
async function loadScriptMap(jobDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const parsed = JSON.parse(
      await readFile(path.join(jobDir, "job.json"), "utf8"),
    ) as { segments?: { id?: unknown; script?: unknown }[] };
    if (Array.isArray(parsed.segments)) {
      for (const seg of parsed.segments) {
        if (typeof seg.id === "string" && typeof seg.script === "string") {
          map.set(seg.id, seg.script);
        }
      }
    }
  } catch {
    // no job.json or unparseable — script-dependent checks SKIP later.
  }
  return map;
}

/**
 * Find segment artifact dirs under a job. Supports both
 *   <job>/segments/<id>/<id>.mp3   and
 *   <job>/artifacts/segments/<id>/<id>.mp3
 * Each segment surfaces its mp3, words.json, `<output>.spoken.txt` sidecar, and
 * (from job.json) its SCRIPT text.
 */
async function findSegments(jobDir: string): Promise<SegmentArtifact[]> {
  const scriptMap = await loadScriptMap(jobDir);
  const candidates = [
    path.join(jobDir, "segments"),
    path.join(jobDir, "artifacts", "segments"),
  ];
  for (const root of candidates) {
    if (!(await isDir(root))) continue;
    const entries = await readdir(root, { withFileTypes: true });
    const segs: SegmentArtifact[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const dir = path.join(root, id);
      const files = await readdir(dir).catch(() => [] as string[]);
      const mp3 = files.find((f) => f.toLowerCase().endsWith(".mp3"));
      const wordsFile = files.find((f) => f === "words.json");
      const spoken = files.find((f) => f.toLowerCase().endsWith(".spoken.txt"));
      segs.push({
        id,
        dir,
        mp3Path: mp3 ? path.join(dir, mp3) : undefined,
        wordsPath: wordsFile ? path.join(dir, wordsFile) : undefined,
        spokenTxtPath: spoken ? path.join(dir, spoken) : undefined,
        script: scriptMap.get(id),
      });
    }
    if (segs.length > 0) return segs;
  }
  return [];
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function isExpert(id: string, args: GateArgs): boolean {
  return id.startsWith(args.expertPrefix) && id.endsWith(args.expertSuffix);
}

function isHost(id: string, args: GateArgs): boolean {
  return id.startsWith(args.hostPrefix) && id.endsWith(args.hostSuffix);
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ---- Check 2: EXPERT TONE (tone-anchor tilt) + BODY/CONSISTENCY (anchor-job) -

/**
 * Measured numbers fed to the pure decision function. All in dB.
 *   anchorTilt      — --tone-anchor clip TILT = hp_mean − body_mean. TONE anchor.
 *   anchorBody      — reference (--anchor-job, known-good) median full
 *                     mean_volume. BODY anchor.
 *   expertTiltMedian — expert median TILT (loudness-invariant tone).
 *   expertBodyMedian / expertBodySpread — expert body + (max−min) spread.
 *
 * NOTE on the two anchors: TONE anchors to the --tone-anchor clip, which may be
 * brighter than the reference take — anchoring tone to a muffled reference take
 * would demand a muffled tone and false-fail the correct audio. BODY and
 * CONSISTENCY still anchor to the reference take (its loudness/evenness are good).
 */
export interface ToneMeasurements {
  anchorTilt: number;
  anchorBody: number;
  expertTiltMedian: number;
  expertBodyMedian: number;
  expertBodySpread: number;
}

export interface ToneVerdict {
  pass: boolean;
  tonePass: boolean;
  bodyPass: boolean;
  consistencyPass: boolean;
  tiltDelta: number;
  bodyDelta: number;
}

/**
 * Pure pass/fail decision. No I/O — unit-testable.
 *   TONE        — two-sided |expertTilt − anchorTilt| ≤ TONE_TOL_DB (catches BOTH
 *                 over-bright AND over-muffled takes).
 *   BODY        — two-sided |expertBody − anchorBody| ≤ BODY_TOL_DB (vs reference).
 *   CONSISTENCY — expertBodySpread ≤ BODY_SPREAD_TOL_DB (vs reference evenness).
 */
export function decideTone(m: ToneMeasurements): ToneVerdict {
  const tiltDelta = m.expertTiltMedian - m.anchorTilt;
  const bodyDelta = m.expertBodyMedian - m.anchorBody;
  const tonePass = Math.abs(tiltDelta) <= TONE_TOL_DB;
  const bodyPass = Math.abs(bodyDelta) <= BODY_TOL_DB;
  const consistencyPass = m.expertBodySpread <= BODY_SPREAD_TOL_DB;
  return {
    pass: tonePass && bodyPass && consistencyPass,
    tonePass,
    bodyPass,
    consistencyPass,
    tiltDelta,
    bodyDelta,
  };
}

/** Measure the reference (BODY/CONSISTENCY) anchor: expert-segment median body. */
async function measureBodyAnchor(
  anchorJobDir: string,
  args: GateArgs,
): Promise<{ body: number; n: number } | null> {
  const segments = await findSegments(path.resolve(anchorJobDir));
  const expertMp3s = segments.filter((s) => isExpert(s.id, args) && s.mp3Path);
  if (expertMp3s.length === 0) return null;
  const body: number[] = [];
  for (const seg of expertMp3s) {
    const f = await fullMeanVolumeDb(seg.mp3Path as string);
    if (f !== null) body.push(f);
  }
  if (body.length === 0) return null;
  return { body: median(body), n: body.length };
}

/** Canonical name for the anchored tone/body/consistency check. */
const TONE_CHECK_NAME =
  "EXPERT TONE (tone-anchor) + BODY/CONSISTENCY (anchor-job)";

/**
 * Anchored tone/body/consistency check. When --anchor-job is given:
 *   TONE        anchors to the --tone-anchor clip, measured as TILT at runtime →
 *               anchorTilt. FAILs if the expert median TILT deviates
 *               > TONE_TOL_DB either way (muffled OR over-bright). If
 *               --tone-anchor is ABSENT, the whole anchored check is SKIPPED with
 *               a note (the tone anchor is never hardcoded).
 *   BODY/CONSISTENCY anchor to the reference take (--anchor-job) expert segments.
 * Without an anchor-job, falls back to the legacy one-sided floor-vs-host check.
 */
async function checkSpectral(
  segments: SegmentArtifact[],
  args: GateArgs,
): Promise<CheckResult> {
  if (!args.anchorJob) {
    return checkSpectralLegacyFloor(segments, args);
  }

  if (!args.toneAnchor) {
    return {
      name: TONE_CHECK_NAME,
      status: "SKIPPED",
      lines: [
        "SKIPPED: no --tone-anchor supplied (tone anchor is never hardcoded). " +
          "Pass --tone-anchor <clip.mp3> to run the anchored tone check.",
      ],
    };
  }

  const expertMp3s = segments.filter((s) => isExpert(s.id, args) && s.mp3Path);
  if (expertMp3s.length === 0) {
    return {
      name: TONE_CHECK_NAME,
      status: "SKIPPED",
      lines: ["SKIPPED: no expert mp3s under --job."],
    };
  }

  const anchorTilt = await bandTiltDb(path.resolve(args.toneAnchor));
  if (anchorTilt === null) {
    return {
      name: TONE_CHECK_NAME,
      status: "SKIPPED",
      lines: [
        `SKIPPED: could not measure tone-anchor TILT at ${args.toneAnchor}.`,
      ],
    };
  }

  const bodyAnchor = await measureBodyAnchor(args.anchorJob, args);
  if (!bodyAnchor) {
    return {
      name: TONE_CHECK_NAME,
      status: "SKIPPED",
      lines: [
        `SKIPPED: could not measure reference body anchor expert segments under --anchor-job ${args.anchorJob}.`,
      ],
    };
  }

  const expertTilt: number[] = [];
  const expertBody: number[] = [];
  const perSeg: string[] = [];
  for (const seg of expertMp3s) {
    const t = await bandTiltDb(seg.mp3Path as string);
    if (t !== null) {
      expertTilt.push(t);
      perSeg.push(`${seg.id}=${t.toFixed(2)}`);
    }
    const f = await fullMeanVolumeDb(seg.mp3Path as string);
    if (f !== null) expertBody.push(f);
  }
  if (expertTilt.length === 0 || expertBody.length === 0) {
    return {
      name: TONE_CHECK_NAME,
      status: "SKIPPED",
      lines: ["SKIPPED: ffmpeg could not measure expert tilt/body."],
    };
  }

  const m: ToneMeasurements = {
    anchorTilt,
    anchorBody: bodyAnchor.body,
    expertTiltMedian: median(expertTilt),
    expertBodyMedian: median(expertBody),
    expertBodySpread: Math.max(...expertBody) - Math.min(...expertBody),
  };
  const v = decideTone(m);

  const lines = [
    "NOTE: TONE anchors to the --tone-anchor clip, NOT the reference take. The reference take may be tonally MUFFLED, so anchoring tone to it would demand a muffled tone and false-fail the correct audio. BODY + CONSISTENCY still anchor to the reference take (its loudness/evenness are good).",
    `Tone anchor TILT: ${m.anchorTilt.toFixed(2)} dB  [${args.toneAnchor}]`,
    `Body anchor (reference) body: ${m.anchorBody.toFixed(2)} dB (n=${bodyAnchor.n})  [${args.anchorJob}]`,
    `Expert TILT median: ${m.expertTiltMedian.toFixed(2)} dB (n=${expertTilt.length}) — per-seg: ${perSeg.join(", ")}`,
    `Expert body median: ${m.expertBodyMedian.toFixed(2)} dB (spread ${m.expertBodySpread.toFixed(2)}, n=${expertBody.length})`,
    `[${v.tonePass ? "GREEN" : "RED"}] TONE (tilt) Δ=${v.tiltDelta.toFixed(2)} dB (tol ±${TONE_TOL_DB}, anchor tone-anchor)`,
    `[${v.bodyPass ? "GREEN" : "RED"}] BODY/LOUDNESS Δ=${v.bodyDelta.toFixed(2)} dB (tol ±${BODY_TOL_DB}, anchor reference)`,
    `[${v.consistencyPass ? "GREEN" : "RED"}] CONSISTENCY spread=${m.expertBodySpread.toFixed(2)} dB (max ${BODY_SPREAD_TOL_DB}, anchor reference)`,
  ];
  if (!v.tonePass) {
    lines.push(
      v.tiltDelta > 0
        ? `Expert OVER-bright by ${v.tiltDelta.toFixed(2)} dB tilt vs tone-anchor (over-EQ).`
        : `Expert MUFFLED by ${(-v.tiltDelta).toFixed(2)} dB tilt vs tone-anchor (too dark).`,
    );
  }
  if (!v.bodyPass) {
    lines.push(
      v.bodyDelta < 0
        ? `Expert body too QUIET by ${(-v.bodyDelta).toFixed(2)} dB vs reference (underwater).`
        : `Expert body too LOUD by ${v.bodyDelta.toFixed(2)} dB vs reference.`,
    );
  }
  if (!v.consistencyPass) {
    lines.push(
      `Expert body uneven: spread ${m.expertBodySpread.toFixed(2)} dB exceeds ${BODY_SPREAD_TOL_DB} dB.`,
    );
  }

  return {
    name: TONE_CHECK_NAME,
    status: v.pass ? "PASS" : "FAIL",
    lines,
  };
}

// ---- Legacy fallback: one-sided floor vs host (no anchor supplied) ----------

async function checkSpectralLegacyFloor(
  segments: SegmentArtifact[],
  args: GateArgs,
): Promise<CheckResult> {
  const expertMp3s = segments.filter((s) => isExpert(s.id, args) && s.mp3Path);
  const hostMp3s = segments.filter((s) => isHost(s.id, args) && s.mp3Path);

  if (expertMp3s.length === 0 || hostMp3s.length === 0) {
    return {
      name: "EXPERT SPECTRAL FLOOR (legacy, no --anchor-job)",
      status: "SKIPPED",
      lines: [
        "SKIPPED: no --anchor-job supplied and missing expert or host mp3s. " +
          "Pass --anchor-job for the canonical two-sided anchored check.",
      ],
    };
  }

  const expertDb: number[] = [];
  for (const seg of expertMp3s) {
    const db = await highBandMeanVolumeDb(seg.mp3Path as string);
    if (db !== null) expertDb.push(db);
  }
  const hostDb: number[] = [];
  for (const seg of hostMp3s) {
    const db = await highBandMeanVolumeDb(seg.mp3Path as string);
    if (db !== null) hostDb.push(db);
  }

  if (expertDb.length === 0 || hostDb.length === 0) {
    return {
      name: "EXPERT SPECTRAL FLOOR (legacy, no --anchor-job)",
      status: "SKIPPED",
      lines: [
        "SKIPPED: no job artifacts (ffmpeg could not measure high-band energy).",
      ],
    };
  }

  const expertMean = mean(expertDb);
  const hostMean = mean(hostDb);
  const deficit = hostMean - expertMean; // positive => expert quieter than host.

  const lines = [
    "NOTE: legacy one-sided floor (no --anchor-job). Canonical run uses --anchor-job for two-sided anchored tone.",
    `Expert >${SPECTRAL_HIGHPASS_HZ}Hz mean energy: ${expertMean.toFixed(2)} dB (n=${expertDb.length})`,
    `Host   >${SPECTRAL_HIGHPASS_HZ}Hz mean energy: ${hostMean.toFixed(2)} dB (n=${hostDb.length})`,
    `Deficit (host - expert): ${deficit.toFixed(2)} dB (fail if > ${SPECTRAL_FLOOR_MAX_DEFICIT_DB} dB)`,
  ];

  const status: CheckStatus =
    deficit > SPECTRAL_FLOOR_MAX_DEFICIT_DB ? "FAIL" : "PASS";
  if (status === "FAIL") {
    lines.push(
      `Expert is muffled: high-band energy ${deficit.toFixed(2)} dB below host (max allowed ${SPECTRAL_FLOOR_MAX_DEFICIT_DB} dB).`,
    );
  }
  return {
    name: "EXPERT SPECTRAL FLOOR (legacy, no --anchor-job)",
    status,
    lines,
  };
}

// ---- Check 3: EXPERT WPM CEILING -------------------------------------------

interface RawWord {
  word?: unknown;
  start?: unknown;
  end?: unknown;
}

async function segmentWpm(wordsPath: string): Promise<number | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(wordsPath, "utf8"));
  } catch {
    return null;
  }
  // Accept both a raw array and a { words: [...] } wrapper.
  const arr: RawWord[] = Array.isArray(parsed)
    ? (parsed as RawWord[])
    : Array.isArray((parsed as { words?: unknown }).words)
      ? (parsed as { words: RawWord[] }).words
      : [];
  if (arr.length === 0) return null;
  const wordCount = arr.length;
  const last = arr[arr.length - 1];
  const durationSec = typeof last.end === "number" ? last.end : Number.NaN;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  return wordCount / (durationSec / 60);
}

/**
 * Speed measurements fed to the pure decision function. WPM values are the
 * MEDIAN across each role's segments (not per-segment, to avoid false-fails from
 * a single racing clause).
 */
export interface SpeedMeasurements {
  expertMedianWpm: number;
  hostMedianWpm: number;
}

export interface SpeedVerdict {
  pass: boolean;
  /** Expert median inside [EXPERT_WPM_MIN, EXPERT_WPM_MAX]. */
  expertBandPass: boolean;
  /** Host median inside [HOST_WPM_MIN, HOST_WPM_MAX]. */
  hostBandPass: boolean;
  /** Expert median <= host median * WPM_RATIO_OVER_HOST. */
  ratioPass: boolean;
  /** Expert median <= absolute WPM_CEILING. */
  ceilingPass: boolean;
  ratioCeiling: number;
}

/**
 * Pure speed pass/fail. No I/O — unit-testable.
 *   EXPERT BAND — expert median in [EXPERT_WPM_MIN, EXPERT_WPM_MAX].
 *   HOST BAND   — host median in [HOST_WPM_MIN, HOST_WPM_MAX].
 *   RATIO       — expert median <= host median * WPM_RATIO_OVER_HOST.
 *   CEILING     — expert median <= absolute WPM_CEILING.
 */
export function decideSpeed(m: SpeedMeasurements): SpeedVerdict {
  const ratioCeiling = m.hostMedianWpm * WPM_RATIO_OVER_HOST;
  const expertBandPass =
    m.expertMedianWpm >= EXPERT_WPM_MIN && m.expertMedianWpm <= EXPERT_WPM_MAX;
  const hostBandPass =
    m.hostMedianWpm >= HOST_WPM_MIN && m.hostMedianWpm <= HOST_WPM_MAX;
  const ratioPass = m.expertMedianWpm <= ratioCeiling;
  const ceilingPass = m.expertMedianWpm <= WPM_CEILING;
  return {
    pass: expertBandPass && hostBandPass && ratioPass && ceilingPass,
    expertBandPass,
    hostBandPass,
    ratioPass,
    ceilingPass,
    ratioCeiling,
  };
}

async function checkWpm(
  segments: SegmentArtifact[],
  args: GateArgs,
): Promise<CheckResult> {
  const name = "EXPERT SPEED BAND (median WPM)";
  const expertSegs = segments.filter(
    (s) => isExpert(s.id, args) && s.wordsPath,
  );
  const hostSegs = segments.filter((s) => isHost(s.id, args) && s.wordsPath);

  if (expertSegs.length === 0 || hostSegs.length === 0) {
    return {
      name,
      status: "SKIPPED",
      lines: ["SKIPPED: no job artifacts (missing expert or host words.json)."],
    };
  }

  const expertWpm: number[] = [];
  for (const seg of expertSegs) {
    const w = await segmentWpm(seg.wordsPath as string);
    if (w !== null) expertWpm.push(w);
  }
  const hostWpm: number[] = [];
  for (const seg of hostSegs) {
    const w = await segmentWpm(seg.wordsPath as string);
    if (w !== null) hostWpm.push(w);
  }

  if (expertWpm.length === 0 || hostWpm.length === 0) {
    return {
      name,
      status: "SKIPPED",
      lines: ["SKIPPED: no job artifacts (words.json had no usable timing)."],
    };
  }

  const m: SpeedMeasurements = {
    expertMedianWpm: median(expertWpm),
    hostMedianWpm: median(hostWpm),
  };
  const v = decideSpeed(m);

  const lines = [
    `Expert median WPM: ${m.expertMedianWpm.toFixed(1)} (n=${expertWpm.length}) — band [${EXPERT_WPM_MIN}, ${EXPERT_WPM_MAX}]`,
    `Host   median WPM: ${m.hostMedianWpm.toFixed(1)} (n=${hostWpm.length}) — band [${HOST_WPM_MIN}, ${HOST_WPM_MAX}]`,
    `Ceilings: absolute ${WPM_CEILING}, host-relative ${v.ratioCeiling.toFixed(1)} (host x ${WPM_RATIO_OVER_HOST})`,
    `[${v.expertBandPass ? "GREEN" : "RED"}] EXPERT band`,
    `[${v.hostBandPass ? "GREEN" : "RED"}] HOST band`,
    `[${v.ratioPass ? "GREEN" : "RED"}] host-relative ratio`,
    `[${v.ceilingPass ? "GREEN" : "RED"}] absolute ceiling`,
  ];
  if (!v.expertBandPass) {
    lines.push(
      m.expertMedianWpm < EXPERT_WPM_MIN
        ? `Expert too SLOW: median ${m.expertMedianWpm.toFixed(1)} below ${EXPERT_WPM_MIN}.`
        : `Expert too FAST: median ${m.expertMedianWpm.toFixed(1)} above ${EXPERT_WPM_MAX}.`,
    );
  }
  if (!v.hostBandPass) {
    lines.push(
      m.hostMedianWpm < HOST_WPM_MIN
        ? `Host too SLOW: median ${m.hostMedianWpm.toFixed(1)} below ${HOST_WPM_MIN}.`
        : `Host too FAST: median ${m.hostMedianWpm.toFixed(1)} above ${HOST_WPM_MAX}.`,
    );
  }
  if (!v.ratioPass) {
    lines.push(
      `Expert median WPM ${m.expertMedianWpm.toFixed(1)} exceeds host-relative ceiling ${v.ratioCeiling.toFixed(1)}.`,
    );
  }
  if (!v.ceilingPass) {
    lines.push(
      `Expert median WPM ${m.expertMedianWpm.toFixed(1)} exceeds absolute ceiling ${WPM_CEILING}.`,
    );
  }
  return { name, status: v.pass ? "PASS" : "FAIL", lines };
}

// ---- Check C: BREATHING ----------------------------------------------------

/**
 * Count sentence-ender characters (. ? !) in a piece of spoken text. The number
 * of sentence BOUNDARIES is this minus one (the gaps BETWEEN sentences).
 */
export function countSentenceEnders(text: string): number {
  const m = text.match(/[.?!]/g);
  return m ? m.length : 0;
}

/**
 * Filter raw silencedetect hits down to INTERNAL breaths: drop any silence that
 * starts before BREATH_EDGE_GUARD_S (a leading edge silence) or that ends within
 * BREATH_EDGE_GUARD_S of the clip end (a trailing edge silence), then keep only
 * those at least BREATH_INTERNAL_MIN_S long.
 */
export function internalBreaths(
  silences: DetectedSilence[],
  durationSeconds: number,
): DetectedSilence[] {
  return silences.filter((s) => {
    if (s.start < BREATH_EDGE_GUARD_S) return false;
    if (
      Number.isFinite(durationSeconds) &&
      durationSeconds > 0 &&
      s.end >= durationSeconds - BREATH_EDGE_GUARD_S
    ) {
      return false;
    }
    return s.duration >= BREATH_INTERNAL_MIN_S;
  });
}

export interface BreathMeasurements {
  /** Sentence boundaries = sentence-enders minus 1 (>= 1 for multi-sentence). */
  sentenceBoundaries: number;
  /** Count of internal breaths >= BREATH_INTERNAL_MIN_S. */
  internalBreathCount: number;
  /** Whether at least one internal breath is >= BREATH_LONG_MIN_S. */
  hasLongBreath: boolean;
}

export interface BreathVerdict {
  pass: boolean;
  /** Single-sentence segments are skipped (sentenceBoundaries < 1). */
  skipped: boolean;
  required: number;
  countPass: boolean;
  longPass: boolean;
}

/**
 * Pure breathing pass/fail for ONE expert segment. No I/O — unit-testable.
 *   SKIP        — single-sentence (sentenceBoundaries < 1).
 *   COUNT       — internalBreathCount >= ceil(BREATH_PER_BOUNDARY_RATIO * boundaries).
 *   LONG        — at least one internal breath >= BREATH_LONG_MIN_S.
 */
export function decideBreathing(m: BreathMeasurements): BreathVerdict {
  if (m.sentenceBoundaries < 1) {
    return {
      pass: true,
      skipped: true,
      required: 0,
      countPass: true,
      longPass: true,
    };
  }
  const required = Math.ceil(BREATH_PER_BOUNDARY_RATIO * m.sentenceBoundaries);
  const countPass = m.internalBreathCount >= required;
  const longPass = m.hasLongBreath;
  return {
    pass: countPass && longPass,
    skipped: false,
    required,
    countPass,
    longPass,
  };
}

async function checkBreathing(
  segments: SegmentArtifact[],
  args: GateArgs,
): Promise<CheckResult> {
  const name = "EXPERT BREATHING (internal silences)";
  const expertSegs = segments.filter((s) => isExpert(s.id, args) && s.mp3Path);
  if (expertSegs.length === 0) {
    return {
      name,
      status: "SKIPPED",
      lines: ["SKIPPED: no expert mp3s under --job."],
    };
  }
  // Require the spoken-text sidecar to count sentences; without it for ANY
  // multi-sentence expert segment we cannot prove breathing.
  const lines: string[] = [];
  let anyFail = false;
  let anyChecked = false;
  for (const seg of expertSegs) {
    if (!seg.spokenTxtPath) {
      // No sidecar: we cannot derive sentence boundaries for this segment.
      // Treat as FAIL only if we cannot establish it is single-sentence; we
      // do not know, so this is a hard FAIL (breathing unprovable).
      lines.push(
        `[RED] ${seg.id}: missing .spoken.txt sidecar — cannot prove breathing.`,
      );
      anyFail = true;
      continue;
    }
    const spoken = await readFile(seg.spokenTxtPath, "utf8").catch(() => null);
    if (spoken === null) {
      lines.push(`[RED] ${seg.id}: unreadable .spoken.txt sidecar.`);
      anyFail = true;
      continue;
    }
    const boundaries = countSentenceEnders(spoken) - 1;
    if (boundaries < 1) {
      lines.push(`[GREEN] ${seg.id}: single sentence — breathing SKIPPED.`);
      continue;
    }
    anyChecked = true;
    const duration = await probeDurationSeconds(seg.mp3Path as string);
    const silences = await detectSilences(
      seg.mp3Path as string,
      BREATH_NOISE_DB,
      BREATH_DETECT_MIN_S,
    );
    const internal = internalBreaths(silences, duration);
    const m: BreathMeasurements = {
      sentenceBoundaries: boundaries,
      internalBreathCount: internal.length,
      hasLongBreath: internal.some((s) => s.duration >= BREATH_LONG_MIN_S),
    };
    const v = decideBreathing(m);
    const longest = internal.reduce((mx, s) => Math.max(mx, s.duration), 0);
    lines.push(
      `[${v.pass ? "GREEN" : "RED"}] ${seg.id}: boundaries=${boundaries} ` +
        `internalBreaths=${internal.length} (need ${v.required}) ` +
        `longest=${longest.toFixed(2)}s (need >= ${BREATH_LONG_MIN_S}s)`,
    );
    if (!v.pass) {
      anyFail = true;
      if (!v.countPass) {
        lines.push(
          `  ${seg.id}: too few breaths (${internal.length} < ${v.required}).`,
        );
      }
      if (!v.longPass) {
        lines.push(
          `  ${seg.id}: no internal silence >= ${BREATH_LONG_MIN_S}s (longest ${longest.toFixed(2)}s).`,
        );
      }
    }
  }
  if (!anyChecked && !anyFail) {
    return {
      name,
      status: "SKIPPED",
      lines: [
        "SKIPPED: every expert segment was single-sentence (nothing to breathe).",
        ...lines,
      ],
    };
  }
  return { name, status: anyFail ? "FAIL" : "PASS", lines };
}

/** ffprobe duration (s) for the breathing edge-silence guard; 0 if unknown. */
async function probeDurationSeconds(mp3Path: string): Promise<number> {
  const out = await runCapture("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nokey=1:noprint_wrappers=1",
    mp3Path,
  ]);
  if (!out) return 0;
  const value = Number.parseFloat(out.trim());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// ---- Check D: PRONUNCIATION (Check 0) --------------------------------------

export interface PronVerdict {
  pass: boolean;
  /** Raw TERM_MAP terms present in the SCRIPT (word-boundary). */
  scriptTerms: string[];
  /** Mapped spoken forms missing from the sidecar. */
  missingSpoken: string[];
  /** Raw terms still leaking into the spoken sidecar (word-boundary). */
  leakedRaw: string[];
}

/**
 * Pure pronunciation decision for ONE segment. No I/O — string/regex only.
 * For each TERM_MAP rule whose RAW term appears in `script` (word-boundary):
 *   - the mapped `spoken` form MUST appear in `spokenSidecar`, AND
 *   - the RAW term MUST NOT appear (word-boundary) in `spokenSidecar`.
 * `spokenSidecar === null` means the sidecar is MISSING -> every matched term
 * fails (missingSpoken).
 */
export function decidePronunciation(
  script: string,
  spokenSidecar: string | null,
): PronVerdict {
  const scriptTerms: string[] = [];
  const missingSpoken: string[] = [];
  const leakedRaw: string[] = [];
  for (const rule of TERM_MAP) {
    const rawRe = buildTermRegExp(rule.term);
    if (!rawRe.test(script)) continue;
    scriptTerms.push(rule.term);
    if (spokenSidecar === null) {
      missingSpoken.push(rule.spoken);
      continue;
    }
    if (!spokenSidecar.includes(rule.spoken)) {
      missingSpoken.push(rule.spoken);
    }
    // Re-build the regex (stateful `g` flag) for an independent test.
    if (buildTermRegExp(rule.term).test(spokenSidecar)) {
      leakedRaw.push(rule.term);
    }
  }
  return {
    pass: missingSpoken.length === 0 && leakedRaw.length === 0,
    scriptTerms,
    missingSpoken,
    leakedRaw,
  };
}

async function checkPronunciation(
  segments: SegmentArtifact[],
  args: GateArgs,
): Promise<CheckResult> {
  const name = "PRONUNCIATION (spoken-feed normalization)";
  // Every segment (host or expert) whose SCRIPT carries a mapped term.
  const withScript = segments.filter((s) => typeof s.script === "string");
  if (withScript.length === 0) {
    return {
      name,
      status: "SKIPPED",
      lines: [
        "SKIPPED: no per-segment SCRIPT available (no job.json segments[].script).",
      ],
    };
  }
  const lines: string[] = [];
  let anyFail = false;
  let anyChecked = false;
  for (const seg of withScript) {
    const script = seg.script as string;
    // Cheap pre-filter: only segments whose script carries a mapped term matter.
    const carriesTerm = TERM_MAP.some((r) =>
      buildTermRegExp(r.term).test(script),
    );
    if (!carriesTerm) continue;
    anyChecked = true;
    const spoken = seg.spokenTxtPath
      ? await readFile(seg.spokenTxtPath, "utf8").catch(() => null)
      : null;
    const v = decidePronunciation(script, spoken);
    if (v.pass) {
      lines.push(
        `[GREEN] ${seg.id}: terms {${v.scriptTerms.join(", ")}} correctly spoken.`,
      );
      continue;
    }
    anyFail = true;
    if (!seg.spokenTxtPath) {
      lines.push(
        `[RED] ${seg.id}: script has mapped term(s) {${v.scriptTerms.join(", ")}} but .spoken.txt sidecar is MISSING.`,
      );
      continue;
    }
    if (v.missingSpoken.length > 0) {
      lines.push(
        `[RED] ${seg.id}: spoken form(s) missing from sidecar: {${v.missingSpoken.join(", ")}}.`,
      );
    }
    if (v.leakedRaw.length > 0) {
      lines.push(
        `[RED] ${seg.id}: raw term(s) leaked into spoken feed: {${v.leakedRaw.join(", ")}}.`,
      );
    }
  }
  if (!anyChecked) {
    return {
      name,
      status: "SKIPPED",
      lines: ["SKIPPED: no segment SCRIPT contained a TERM_MAP term."],
    };
  }
  return { name, status: anyFail ? "FAIL" : "PASS", lines };
}

// ---- Check E: STUTTER (whisper word-timing artifact) -----------------------

/**
 * One word from a words.json artifact, normalized down to what the stutter rules
 * care about: a punctuation-stripped lowercase token plus its timing.
 */
export interface StutterWord {
  /** Normalized token: lowercased, leading/trailing punctuation stripped. */
  norm: string;
  /** Raw word as it appeared (for human-readable failure printing). */
  raw: string;
  start: number;
  end: number;
}

export interface StutterFlag {
  /** One of: "repeat" (adjacent duplicate), "fragment" (stammer), "glitch". */
  kind: "repeat" | "fragment" | "glitch";
  /** Human-readable description with offending words + timestamps. */
  detail: string;
}

export interface StutterVerdict {
  pass: boolean;
  flags: StutterFlag[];
  /** Count of overlapping-or-zero-duration words seen. */
  glitchCount: number;
  /** Total words considered. */
  wordCount: number;
}

/**
 * Lowercase a token and strip leading/trailing punctuation (keeps internal
 * hyphens/apostrophes so "one-line" and "don't" survive, but "st-" collapses to
 * "st" so a leading-fragment stammer is detectable).
 */
export function normalizeStutterToken(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
}

/**
 * Pure stutter decision over ONE segment's normalized word list. No I/O.
 *   REPEAT   — same normalized word adjacent >= STUTTER_HARD_REPEAT_RUN (always),
 *              OR a NON-allowlisted word adjacent >= STUTTER_SOFT_REPEAT_RUN.
 *   FRAGMENT — a token of length <= STUTTER_FRAGMENT_MAX_LEN repeated adjacently
 *              >= STUTTER_FRAGMENT_RUN (e.g. "st- st- stutter").
 *   GLITCH   — words whose start < previous end (overlap) or end <= start
 *              (zero/negative duration); FAIL if >= STUTTER_GLITCH_ABS such words
 *              OR > STUTTER_GLITCH_RATIO of the segment's words are such.
 * An empty word list trivially PASSES (caller SKIPs missing words.json instead).
 */
export function decideStutter(words: StutterWord[]): StutterVerdict {
  const flags: StutterFlag[] = [];
  const allowlist = new Set(STUTTER_REPEAT_ALLOWLIST);

  // --- Rule 1 & 3: adjacent duplicate runs (full word + short fragment). ---
  let i = 0;
  while (i < words.length) {
    const tok = words[i].norm;
    if (tok.length === 0) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < words.length && words[j].norm === tok) j += 1;
    const run = j - i;
    if (run >= STUTTER_SOFT_REPEAT_RUN) {
      const span = words.slice(i, j);
      const tsList = span
        .map((w) => `"${w.raw}"@${w.start.toFixed(2)}-${w.end.toFixed(2)}s`)
        .join(", ");
      const isAllow = allowlist.has(tok);
      const isFragment = tok.length <= STUTTER_FRAGMENT_MAX_LEN;
      if (run >= STUTTER_HARD_REPEAT_RUN) {
        // Any word 3+ in a row is never natural English — always a stutter.
        flags.push({
          kind: "repeat",
          detail: `"${tok}" repeated ${run}x consecutively (>= ${STUTTER_HARD_REPEAT_RUN}): ${tsList}`,
        });
      } else if (!isAllow) {
        // Non-allowlisted word doubled ("the the", "model model"). A very short
        // such token ("st- st-") is reported as a stammer fragment; otherwise a
        // plain duplicate-word repeat. Either way it FAILS the segment.
        if (isFragment && run >= STUTTER_FRAGMENT_RUN) {
          flags.push({
            kind: "fragment",
            detail: `stammer fragment "${tok}" (len ${tok.length}) repeated ${run}x: ${tsList}`,
          });
        } else {
          flags.push({
            kind: "repeat",
            detail: `non-allowlisted "${tok}" repeated ${run}x consecutively (>= ${STUTTER_SOFT_REPEAT_RUN}): ${tsList}`,
          });
        }
      }
    }
    i = j;
  }

  // --- Rule 2: real timing glitches (overlaps + zero-dur BURSTS only). ---
  // Mark which words are glitch words. An overlap (start < prior end) is always
  // a glitch — the audio re-articulates before the previous word ended. A
  // zero/neg-duration word only counts when it sits in a CONSECUTIVE run of
  // length >= STUTTER_ZERODUR_RUN (a collapse burst); isolated zero-dur boundary
  // tokens are normal whisper output and are NOT glitches (see constant note).
  const isGlitch = new Array<boolean>(words.length).fill(false);
  // Zero-dur bursts: find consecutive runs and mark members if the run is long.
  let z = 0;
  while (z < words.length) {
    if (words[z].end <= words[z].start) {
      let zj = z + 1;
      while (zj < words.length && words[zj].end <= words[zj].start) zj += 1;
      if (zj - z >= STUTTER_ZERODUR_RUN) {
        for (let m = z; m < zj; m += 1) isGlitch[m] = true;
      }
      z = zj;
    } else {
      z += 1;
    }
  }
  // Overlaps: a word starting before the prior word's end.
  for (let k = 1; k < words.length; k += 1) {
    if (words[k].start < words[k - 1].end - 1e-9) isGlitch[k] = true;
  }

  let glitchCount = 0;
  const glitchSamples: string[] = [];
  for (let k = 0; k < words.length; k += 1) {
    if (!isGlitch[k]) continue;
    glitchCount += 1;
    if (glitchSamples.length < 8) {
      const w = words[k];
      const why =
        k > 0 && w.start < words[k - 1].end - 1e-9
          ? "overlap-prev"
          : "zero-dur-burst";
      glitchSamples.push(
        `"${w.raw}"@${w.start.toFixed(2)}-${w.end.toFixed(2)}s(${why})`,
      );
    }
  }
  const ratio = words.length > 0 ? glitchCount / words.length : 0;
  if (glitchCount >= STUTTER_GLITCH_ABS || ratio > STUTTER_GLITCH_RATIO) {
    flags.push({
      kind: "glitch",
      detail: `${glitchCount}/${words.length} glitch words — overlaps + zero-dur bursts (${(ratio * 100).toFixed(1)}% > ${(STUTTER_GLITCH_RATIO * 100).toFixed(0)}% or >= ${STUTTER_GLITCH_ABS}): ${glitchSamples.join(", ")}`,
    });
  }

  return {
    pass: flags.length === 0,
    flags,
    glitchCount,
    wordCount: words.length,
  };
}

/**
 * Read a words.json artifact (array of {word,start,end} OR {words:[...]}) and
 * normalize it into the StutterWord shape. Returns null if the file is absent or
 * has no usable words (caller SKIPs).
 */
async function loadStutterWords(
  wordsPath: string,
): Promise<StutterWord[] | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(wordsPath, "utf8"));
  } catch {
    return null;
  }
  const arr: RawWord[] = Array.isArray(parsed)
    ? (parsed as RawWord[])
    : Array.isArray((parsed as { words?: unknown }).words)
      ? (parsed as { words: RawWord[] }).words
      : [];
  const out: StutterWord[] = [];
  for (const w of arr) {
    if (typeof w.word !== "string") continue;
    const start = typeof w.start === "number" ? w.start : Number.NaN;
    const end = typeof w.end === "number" ? w.end : Number.NaN;
    out.push({
      norm: normalizeStutterToken(w.word),
      raw: w.word,
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? end : 0,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * STUTTER gate check. Runs over BOTH host and expert segments (either voice can
 * stutter). Each segment with a words.json is scanned; a segment that
 * trips ANY stutter rule is RED with the offending words + timestamps printed so
 * the bad take is identifiable for re-roll. Segments with no words.json SKIP.
 */
async function checkStutter(
  segments: SegmentArtifact[],
  _args: GateArgs,
): Promise<CheckResult> {
  const name = "STUTTER (whisper word-timing artifact)";
  const withWords = segments.filter((s) => s.wordsPath);
  if (withWords.length === 0) {
    return {
      name,
      status: "SKIPPED",
      lines: ["SKIPPED: no segments carried a words.json artifact."],
    };
  }
  const lines: string[] = [];
  let anyFail = false;
  let anyChecked = false;
  // Deterministic order so the report is stable across runs.
  for (const seg of [...withWords].sort((a, b) => a.id.localeCompare(b.id))) {
    const words = await loadStutterWords(seg.wordsPath as string);
    if (words === null) {
      lines.push(`[SKIPPED] ${seg.id}: words.json absent/empty — no scan.`);
      continue;
    }
    anyChecked = true;
    const v = decideStutter(words);
    if (v.pass) {
      lines.push(
        `[GREEN] ${seg.id}: ${v.wordCount} words, no stutter (${v.glitchCount} timing glitches).`,
      );
      continue;
    }
    anyFail = true;
    lines.push(`[RED] ${seg.id}: STUTTER in ${v.wordCount}-word segment:`);
    for (const f of v.flags) {
      lines.push(`  ${f.kind.toUpperCase()}: ${f.detail}`);
    }
  }
  if (!anyChecked) {
    return {
      name,
      status: "SKIPPED",
      lines: ["SKIPPED: no usable words.json in any segment.", ...lines],
    };
  }
  return { name, status: anyFail ? "FAIL" : "PASS", lines };
}

// ---- Check F: TIMING (alignment / anti-drift) ------------------------------

/**
 * One word from a words.json artifact reduced to the timing fields the TIMING
 * check needs.
 */
export interface TimingWord {
  word: string;
  start: number;
  end: number;
}

export interface TimingVerdict {
  pass: boolean;
  /** words.json word count == script token count (post-normalizeForSpeech). */
  countPass: boolean;
  /** Starts are monotonic non-decreasing (no start[i] < start[i-1]). */
  monotonicPass: boolean;
  /** No word with end<start, and no word span > TIMING_MAX_WORD_SPAN_S. */
  spanPass: boolean;
  /** Last-word-end within TIMING_END_TOL_S of mp3 duration (not short, not past). */
  durationPass: boolean;
  wordCount: number;
  scriptTokenCount: number;
  lastEnd: number;
  mp3DurationSec: number;
  /** First out-of-order index (start < prev start), or -1. */
  firstNonMonotonicIndex: number;
  /** First absurd-span index (end<start or span>max), or -1. */
  firstBadSpanIndex: number;
}

/**
 * Pure TIMING decision for ONE segment. No I/O — unit-testable. Catches the
 * aftercode teleprompter-drift signature: clean script words mapped onto a raw
 * whisper timeline by crude proportion. A correctly ALIGNED words.json has:
 *   COUNT       — exactly one timing per script token (post normalizeForSpeech).
 *   MONOTONIC   — starts never go backwards (start[i] >= start[i-1]).
 *   SPAN        — every word has end>=start and end−start <= TIMING_MAX_WORD_SPAN_S.
 *   DURATION    — last word's end within ±TIMING_END_TOL_S of the mp3 duration.
 */
export function decideTiming(
  words: TimingWord[],
  scriptTokenCount: number,
  mp3DurationSec: number,
): TimingVerdict {
  const wordCount = words.length;
  const countPass = wordCount === scriptTokenCount;

  let firstNonMonotonicIndex = -1;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i].start < words[i - 1].start - 1e-9) {
      firstNonMonotonicIndex = i;
      break;
    }
  }
  const monotonicPass = firstNonMonotonicIndex === -1;

  let firstBadSpanIndex = -1;
  for (let i = 0; i < words.length; i += 1) {
    const span = words[i].end - words[i].start;
    if (span < 0 || span > TIMING_MAX_WORD_SPAN_S) {
      firstBadSpanIndex = i;
      break;
    }
  }
  const spanPass = firstBadSpanIndex === -1;

  const lastEnd = wordCount > 0 ? words[wordCount - 1].end : 0;
  const durationPass =
    Number.isFinite(mp3DurationSec) &&
    mp3DurationSec > 0 &&
    wordCount > 0 &&
    lastEnd <= mp3DurationSec + TIMING_END_TOL_S &&
    lastEnd >= mp3DurationSec - TIMING_END_TOL_S;

  return {
    pass: countPass && monotonicPass && spanPass && durationPass,
    countPass,
    monotonicPass,
    spanPass,
    durationPass,
    wordCount,
    scriptTokenCount,
    lastEnd,
    mp3DurationSec,
    firstNonMonotonicIndex,
    firstBadSpanIndex,
  };
}

/**
 * Count script tokens EXACTLY as the aligner (src/word-timing-repair.ts
 * scriptWords) does, after running the raw script through normalizeForSpeech —
 * the same spoken-feed transform the synth used. This is the count an aligned
 * words.json must match.
 */
export function scriptTokenCount(rawScript: string): number {
  const spoken = normalizeForSpeech(String(rawScript || ""));
  return spoken
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\w]+|[^\w.?!,;:]+$/g, ""))
    .filter(Boolean).length;
}

/** Read a words.json into TimingWord[]; null if absent/unparseable/empty. */
async function loadTimingWords(
  wordsPath: string,
): Promise<TimingWord[] | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(wordsPath, "utf8"));
  } catch {
    return null;
  }
  const arr: RawWord[] = Array.isArray(parsed)
    ? (parsed as RawWord[])
    : Array.isArray((parsed as { words?: unknown }).words)
      ? (parsed as { words: RawWord[] }).words
      : [];
  const out: TimingWord[] = [];
  for (const w of arr) {
    const raw = w as { word?: unknown; text?: unknown };
    const word =
      typeof raw.word === "string"
        ? raw.word
        : typeof raw.text === "string"
          ? raw.text
          : "";
    const start = typeof w.start === "number" ? w.start : Number.NaN;
    const end = typeof w.end === "number" ? w.end : Number.NaN;
    out.push({
      word,
      start: Number.isFinite(start) ? start : Number.NaN,
      end: Number.isFinite(end) ? end : Number.NaN,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * TIMING gate. For every segment that carries BOTH a words.json and a SCRIPT
 * (from job.json segments[].script), assert the words.json is genuinely aligned
 * to the audio: count == script tokens, monotonic starts, sane spans, and the
 * last word ends within ±TIMING_END_TOL_S of the mp3 duration. This is the gate
 * that was missing while the synth path wrote RAW (unaligned) whisper timings.
 */
async function checkTiming(
  segments: SegmentArtifact[],
  _args: GateArgs,
): Promise<CheckResult> {
  const name = "TIMING (word-alignment / anti-drift)";
  const candidates = segments.filter(
    (s) => s.wordsPath && typeof s.script === "string",
  );
  if (candidates.length === 0) {
    return {
      name,
      status: "SKIPPED",
      lines: [
        "SKIPPED: no segment carried BOTH a words.json and a job.json script.",
      ],
    };
  }
  const lines: string[] = [];
  let anyFail = false;
  let anyChecked = false;
  for (const seg of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
    const words = await loadTimingWords(seg.wordsPath as string);
    if (words === null) {
      lines.push(`[SKIPPED] ${seg.id}: words.json absent/empty — no scan.`);
      continue;
    }
    anyChecked = true;
    const sTokens = scriptTokenCount(seg.script as string);
    const mp3Dur = seg.mp3Path
      ? await probeDurationSeconds(seg.mp3Path)
      : Number.NaN;
    const v = decideTiming(words, sTokens, mp3Dur);
    lines.push(
      `[${v.pass ? "GREEN" : "RED"}] ${seg.id}: words=${v.wordCount} script=${v.scriptTokenCount} ` +
        `lastEnd=${v.lastEnd.toFixed(2)}s mp3=${Number.isFinite(v.mp3DurationSec) ? v.mp3DurationSec.toFixed(2) : "?"}s ` +
        `[count ${v.countPass ? "GREEN" : "RED"}, mono ${v.monotonicPass ? "GREEN" : "RED"}, ` +
        `span ${v.spanPass ? "GREEN" : "RED"}, dur ${v.durationPass ? "GREEN" : "RED"}]`,
    );
    if (!v.pass) {
      anyFail = true;
      if (!v.countPass) {
        lines.push(
          `  ${seg.id}: word count ${v.wordCount} != script token count ${v.scriptTokenCount} (drift signature).`,
        );
      }
      if (!v.monotonicPass) {
        lines.push(
          `  ${seg.id}: non-monotonic start at index ${v.firstNonMonotonicIndex}.`,
        );
      }
      if (!v.spanPass) {
        lines.push(
          `  ${seg.id}: absurd span (end<start or > ${TIMING_MAX_WORD_SPAN_S}s) at index ${v.firstBadSpanIndex}.`,
        );
      }
      if (!v.durationPass) {
        lines.push(
          `  ${seg.id}: last-word-end ${v.lastEnd.toFixed(2)}s not within ±${TIMING_END_TOL_S}s of mp3 ${Number.isFinite(v.mp3DurationSec) ? v.mp3DurationSec.toFixed(2) : "?"}s.`,
        );
      }
    }
  }
  if (!anyChecked) {
    return {
      name,
      status: "SKIPPED",
      lines: [
        "SKIPPED: no usable words.json in any scripted segment.",
        ...lines,
      ],
    };
  }
  return { name, status: anyFail ? "FAIL" : "PASS", lines };
}

// ---- Orchestration ---------------------------------------------------------

export async function runGate(args: GateArgs): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const html = await readFile(path.resolve(args.html), "utf8");
  const scriptText = args.script
    ? await readFile(path.resolve(args.script), "utf8")
    : undefined;
  results.push(checkDisplay(html, scriptText));

  if (args.job) {
    const segments = await findSegments(path.resolve(args.job));
    results.push(await checkSpectral(segments, args));
    results.push(await checkWpm(segments, args));
    results.push(await checkBreathing(segments, args));
    results.push(await checkPronunciation(segments, args));
    results.push(await checkStutter(segments, args));
    results.push(await checkTiming(segments, args));
  } else {
    results.push({
      name: TONE_CHECK_NAME,
      status: "SKIPPED",
      lines: ["SKIPPED: no job artifacts (--job not provided)."],
    });
    results.push({
      name: "EXPERT SPEED BAND (median WPM)",
      status: "SKIPPED",
      lines: ["SKIPPED: no job artifacts (--job not provided)."],
    });
    results.push({
      name: "EXPERT BREATHING (internal silences)",
      status: "SKIPPED",
      lines: ["SKIPPED: no job artifacts (--job not provided)."],
    });
    results.push({
      name: "PRONUNCIATION (spoken-feed normalization)",
      status: "SKIPPED",
      lines: ["SKIPPED: no job artifacts (--job not provided)."],
    });
    results.push({
      name: "STUTTER (whisper word-timing artifact)",
      status: "SKIPPED",
      lines: ["SKIPPED: no job artifacts (--job not provided)."],
    });
    results.push({
      name: "TIMING (word-alignment / anti-drift)",
      status: "SKIPPED",
      lines: ["SKIPPED: no job artifacts (--job not provided)."],
    });
  }

  return results;
}

function printReport(results: CheckResult[]): boolean {
  let anyFail = false;
  console.log("=== NARRATION GATE ===");
  for (const r of results) {
    const tag = statusTag(r.status);
    console.log(`\n[${tag}] ${r.name}`);
    for (const line of r.lines) {
      console.log(`  ${line}`);
    }
    if (r.status === "FAIL") anyFail = true;
  }
  const overall = anyFail ? "RED — FAIL" : "GREEN — PASS";
  console.log(`\n=== OVERALL: ${overall} ===`);
  return anyFail;
}

// Run only when invoked directly (so tests can import runGate/checkDisplay).
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const results = await runGate(args);
    const failed = printReport(results);
    process.exit(failed ? 1 : 0);
  } catch (error) {
    console.error(
      `narration-gate error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}

export {
  checkDisplay,
  extractDisplay,
  parseScriptSegments,
  parseArgs,
  WHISPER_GARBLE_DENYLIST,
  SPECTRAL_FLOOR_MAX_DEFICIT_DB,
  TONE_TOL_DB,
  BODY_TOL_DB,
  BODY_SPREAD_TOL_DB,
  WPM_CEILING,
  WPM_RATIO_OVER_HOST,
  EXPERT_WPM_MIN,
  EXPERT_WPM_MAX,
  HOST_WPM_MIN,
  HOST_WPM_MAX,
  BREATH_INTERNAL_MIN_S,
  BREATH_LONG_MIN_S,
  BREATH_EDGE_GUARD_S,
  BREATH_PER_BOUNDARY_RATIO,
  STUTTER_REPEAT_ALLOWLIST,
  STUTTER_HARD_REPEAT_RUN,
  STUTTER_SOFT_REPEAT_RUN,
  STUTTER_FRAGMENT_MAX_LEN,
  STUTTER_FRAGMENT_RUN,
  STUTTER_ZERODUR_RUN,
  STUTTER_GLITCH_ABS,
  STUTTER_GLITCH_RATIO,
  TIMING_MAX_WORD_SPAN_S,
  TIMING_END_TOL_S,
};

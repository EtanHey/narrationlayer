#!/usr/bin/env bun
/**
 * local-tts-runner — standalone single-text -> WAV runner for BYO-voice consumers.
 *
 * This is the LOCAL_TTS_COMMAND target for AfterCode's LocalTts provider. AfterCode
 * invokes an external command once per segment, substituting these placeholders:
 *   {text} {output} {reference} {reference_text} {role}
 *
 * Contract (what AfterCode's RIFF reader needs back):
 *   - A MONO, 16-bit PCM (s16le) WAV written to {output}
 *   - at the configured sample rate (default 24000)
 *   - exit 0 on success (non-empty WAV written), non-zero on any failure.
 *
 * Design notes:
 *   - REUSES the existing qwen3 :8880 /synthesize path (same request body shape as
 *     src/renderers/voicelayer-qwen3.ts). We do NOT reinvent the voice engine.
 *   - REUSES src/profiles.ts to resolve a profile NAME (e.g. host-a, expert-b) into
 *     its registered reference clip + ref text + auth token. --reference also accepts
 *     a direct path to a .wav clip.
 *   - VOICE-PROFILE GATE (fail-closed): the resolved reference MUST be a registered
 *     clone (or an existing reference .wav). If the profile/reference is missing we
 *     exit non-zero with a clear error. We NEVER silently fall back to system TTS.
 *   - The daemon returns base64 audio (typically mp3). We always run it through ffmpeg
 *     to guarantee mono s16le WAV at the target rate, so AfterCode's reader accepts it.
 */

import {
  readFile,
  writeFile,
  mkdir,
  stat,
  rename,
  copyFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { findProfile, qwenConfigFromProfile, warnIfNonAcceptedProfile } from "../src/profiles.js";
import { normalizeForSpeech } from "../src/text-normalize.js";

interface Args {
  text?: string;
  output?: string;
  reference?: string;
  referenceText?: string;
  role?: string;
  sampleRate: number;
  daemonUrl?: string;
  authTokenFile?: string;
  timeoutMs: number;
  /** Content-hash freeze cache. Default ON; --no-cache disables it. */
  cache: boolean;
  /** Override the cache directory (default ~/.narrationlayer/tts-cache). */
  cacheDir?: string;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function fail(message: string): never {
  process.stderr.write(`local-tts-runner: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sampleRate: 24000, timeoutMs: 120_000, cache: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (): string => {
      const eq = arg.indexOf("=");
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[i + 1];
      if (next === undefined) fail(`missing value for ${arg}`);
      i += 1;
      return next;
    };
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    switch (name) {
      case "--text":
        args.text = takeValue();
        break;
      case "--output":
        args.output = takeValue();
        break;
      case "--reference":
        args.reference = takeValue();
        break;
      case "--reference-text":
        args.referenceText = takeValue();
        break;
      case "--role":
        args.role = takeValue();
        break;
      case "--sample-rate":
        args.sampleRate = Number(takeValue());
        break;
      case "--daemon-url":
        args.daemonUrl = takeValue();
        break;
      case "--auth-token-file":
        args.authTokenFile = takeValue();
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(takeValue());
        break;
      case "--cache":
        args.cache = true;
        break;
      case "--no-cache":
        args.cache = false;
        break;
      case "--cache-dir":
        args.cacheDir = takeValue();
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `local-tts-runner — single text -> mono s16 WAV via narrationlayer qwen3 daemon

Usage:
  bun bin/local-tts-runner.ts --text "..." --output out.wav --reference <profile|path> [options]

Required:
  --text <string>          Text to synthesize
  --output <path>          Destination .wav (mono 16-bit PCM)
  --reference <profile|path>
                           Registered voice PROFILE name (e.g. host-a, expert-b)
                           OR a direct path to a reference .wav clip.

Options:
  --reference-text <string>  Reference transcript (overrides profile ref text)
  --role <host|expert>       Informational; passed by AfterCode. No engine effect.
  --sample-rate <hz>         Output sample rate (default 24000)
  --daemon-url <url>         Override daemon URL (default from profile or :8880)
  --auth-token-file <path>   Override Bearer token file (default from profile)
  --timeout-ms <ms>          Synthesis timeout (default 120000)
  --cache / --no-cache       Content-hash freeze cache (default ON). On a HIT the
                             frozen WAV is copied to --output, skipping the daemon.
  --cache-dir <path>         Cache directory (default ~/.narrationlayer/tts-cache)

Fail-closed: a missing profile/reference exits non-zero. Never falls back to system TTS.
`;

/**
 * Synth params that affect the OUTPUT bytes. The content-hash key is computed over
 * the normalized spoken text + reference identity + this param object, so any change
 * that would change the audio yields a different key (and a fresh synth), while an
 * identical request reuses the frozen accepted take. Exported for tests.
 */
export interface CacheKeyParams {
  eqHighshelfHz?: number;
  eqHighshelfGainDb?: number;
  loudnessTargetDb?: number;
  atempo?: number;
  sentencePauseSeconds?: number;
  commaPauseSeconds?: number;
}

/**
 * Compute the content-hash freeze key (sha256, hex) for a synth request. The key is
 * the determinism layer: qwen3 is non-deterministic, so freezing an accepted take by
 * its key is the canonical mechanism for reproducibility. The hash covers the LITERAL
 * normalized spoken text (what the daemon receives), the reference clip path + ref
 * text (voice identity), and the JSON of the OUTPUT-affecting synth params. Param keys
 * are serialized in a STABLE order so the key is independent of object construction
 * order; undefined params are omitted (a profile that never sets atempo hashes the same
 * with or without an explicit undefined). Exported for tests.
 */
export function computeContentHashKey(input: {
  spokenText: string;
  referenceClip: string;
  referenceText: string;
  profileId?: string;
  profileVersion?: string;
  model?: string;
  params: CacheKeyParams;
}): string {
  // Stable, explicit param ordering — never rely on object key insertion order.
  const p = input.params;
  const orderedParams = {
    eqHighshelfHz: p.eqHighshelfHz,
    eqHighshelfGainDb: p.eqHighshelfGainDb,
    loudnessTargetDb: p.loudnessTargetDb,
    atempo: p.atempo,
    sentencePauseSeconds: p.sentencePauseSeconds,
    commaPauseSeconds: p.commaPauseSeconds,
  };
  // JSON.stringify drops undefined values, so absent params don't perturb the key.
  const payload = JSON.stringify({
    spokenText: input.spokenText,
    referenceClip: input.referenceClip,
    referenceText: input.referenceText,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    model: input.model,
    params: orderedParams,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

async function resolveReference(args: Args): Promise<{
  referenceClip: string;
  referenceText: string;
  daemonUrl: string;
  authTokenFile: string;
  source: string;
  profileId?: string;
  profileVersion?: string;
  model?: string;
  eqHighshelfHz?: number;
  eqHighshelfGainDb?: number;
  loudnessTargetDb?: number;
  atempo?: number;
  sentencePauseSeconds?: number;
  commaPauseSeconds?: number;
}> {
  const ref = args.reference;
  if (!ref)
    fail("--reference is required (a registered profile name or a .wav path)");

  // Defaults (overridable per-flag); the qwen3 renderer defaults to :8880 too.
  let daemonUrl = args.daemonUrl || "http://127.0.0.1:8880";
  let authTokenFile = args.authTokenFile || "~/.voicelayer/daemon.secret";

  // Case 1: direct path to a reference clip.
  const looksLikePath =
    ref.startsWith("/") ||
    ref.startsWith("~") ||
    ref.startsWith(".") ||
    ref.endsWith(".wav");
  if (looksLikePath) {
    const clip = path.resolve(expandHome(ref));
    if (!existsSync(clip)) {
      fail(
        `reference clip not found: ${clip} (fail-closed; will NOT fall back to system TTS)`,
      );
    }
    let referenceText = args.referenceText?.trim() ?? "";
    if (!referenceText) {
      // Convention: sibling .txt next to the clip.
      const txt = clip.replace(/\.wav$/i, ".txt");
      if (existsSync(txt)) referenceText = (await readFile(txt, "utf8")).trim();
    }
    if (!referenceText) {
      fail(
        `reference text required for clip ${clip} — pass --reference-text or place a sibling .txt`,
      );
    }
    return {
      referenceClip: clip,
      referenceText,
      daemonUrl,
      authTokenFile,
      source: `clip:${clip}`,
    };
  }

  // Case 2: registered profile name. GATE: profile must exist and be a clone.
  const profile = await findProfile(ref, path.resolve(import.meta.dir, ".."));
  if (!profile) {
    fail(
      `voice profile "${ref}" is not registered in profiles.local.yaml (fail-closed; will NOT fall back to system TTS)`,
    );
  }
  if (profile.renderer && profile.renderer !== "voicelayer-qwen3") {
    fail(
      `voice profile "${ref}" uses renderer "${profile.renderer}", not the qwen3 clone engine — refusing (fail-closed)`,
    );
  }
  warnIfNonAcceptedProfile(profile, ref);
  const cfg = qwenConfigFromProfile(profile);
  const referenceClip = cfg.reference_clip || cfg.reference_clips?.[0];
  if (!referenceClip) {
    fail(
      `voice profile "${ref}" has no reference_clip — not a usable clone (fail-closed)`,
    );
  }
  const resolvedClip = path.resolve(expandHome(referenceClip));
  if (!existsSync(resolvedClip)) {
    fail(
      `voice profile "${ref}" reference clip missing on disk: ${resolvedClip} (fail-closed)`,
    );
  }
  // Resolve reference text: explicit flag > profile inline > profile text path.
  let referenceText =
    args.referenceText?.trim() ?? cfg.reference_text?.trim() ?? "";
  if (!referenceText && cfg.reference_text_path) {
    const txtPath = path.resolve(expandHome(cfg.reference_text_path));
    if (existsSync(txtPath))
      referenceText = (await readFile(txtPath, "utf8")).trim();
  }
  if (!referenceText) {
    fail(
      `voice profile "${ref}" has no reference text (reference_text / reference_text_path) — refusing (fail-closed)`,
    );
  }
  if (cfg.daemon_url) daemonUrl = cfg.daemon_url;
  if (cfg.auth_token_file) authTokenFile = cfg.auth_token_file;

  return {
    referenceClip: resolvedClip,
    referenceText,
    daemonUrl,
    authTokenFile,
    source: `profile:${ref}`,
    profileId: profile.id,
    profileVersion: profile.profile_version,
    model: cfg.model,
    eqHighshelfHz: cfg.eq_highshelf_hz,
    eqHighshelfGainDb: cfg.eq_highshelf_gain_db,
    loudnessTargetDb: cfg.loudness_target_db,
    atempo: cfg.atempo,
    sentencePauseSeconds: cfg.sentence_pause_seconds,
    commaPauseSeconds: cfg.comma_pause_seconds,
  };
}

async function synthesize(opts: {
  daemonUrl: string;
  authToken: string;
  referenceClip: string;
  referenceText: string;
  model?: string;
  text: string;
  timeoutMs: number;
}): Promise<Buffer> {
  // Same request shape as src/renderers/voicelayer-qwen3.ts synthesizeText().
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${opts.daemonUrl.replace(/\/+$/, "")}/synthesize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.authToken}`,
      },
      body: JSON.stringify({
        text: opts.text,
        reference_wav: opts.referenceClip,
        reference_text: opts.referenceText,
        ...(opts.model ? { model: opts.model } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    fail(
      `daemon /synthesize failed (${response.status}): ${body || response.statusText}`,
    );
  }

  const payload = (await response.json()) as { audio_b64?: unknown };
  if (typeof payload.audio_b64 !== "string" || !payload.audio_b64) {
    fail("daemon response missing audio_b64");
  }
  return Buffer.from(payload.audio_b64 as string, "base64");
}

interface MonoS16WavOptions {
  /** De-muffle high-shelf EQ frequency (Hz). Profile-gated; only set for eq-bearing profiles. */
  eqHighshelfHz?: number;
  /** De-muffle high-shelf EQ gain (dB). */
  eqHighshelfGainDb?: number;
}

/**
 * Build the ffmpeg argv for the single mono s16le WAV pass. Exported for tests.
 * When EITHER eq param is set, a `highshelf=f=<hz>:g=<gain>` filter (mirroring
 * src/audio.ts applyAudioEq, same defaults hz=4000/g=0) is composed into a single
 * `-af` — no second re-encode pass. When neither is set, no `-af` is added.
 */
export function buildMonoS16WavArgs(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  options: MonoS16WavOptions = {},
): string[] {
  const { eqHighshelfHz, eqHighshelfGainDb } = options;
  // -ac 1 (mono), -c:a pcm_s16le (16-bit PCM), -ar <rate> (target sample rate).
  const args = ["-y", "-i", inputPath, "-ac", "1", "-ar", String(sampleRate)];
  if (eqHighshelfHz !== undefined || eqHighshelfGainDb !== undefined) {
    const hz = eqHighshelfHz ?? 4000;
    const gain = eqHighshelfGainDb ?? 0;
    args.push("-af", `highshelf=f=${hz}:g=${gain}`);
  }
  args.push("-c:a", "pcm_s16le", outputPath);
  return args;
}

function ffmpegToMonoS16Wav(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  options: MonoS16WavOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      buildMonoS16WavArgs(inputPath, outputPath, sampleRate, options),
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Compute the dB gain needed to bring a measured mean_volume up/down to a target.
 * gainDb = target - measured. Exported for tests.
 */
export function computeLoudnessGainDb(
  measuredMeanVolumeDb: number,
  targetDb: number,
): number {
  return targetDb - measuredMeanVolumeDb;
}

/**
 * Build the ffmpeg argv for the loudness-normalize re-encode pass. Applies
 * `volume=<gainDb>dB` to hit the target RMS, followed by `alimiter=limit=0.95`
 * to prevent clipping on boost, keeping mono/s16le/sampleRate. Exported for tests.
 */
export function buildLoudnessNormalizeArgs(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  gainDb: number,
): string[] {
  return [
    "-y",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-af",
    `volume=${gainDb}dB,alimiter=limit=0.95`,
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}

/**
 * Build the ffmpeg argv for the per-profile ATEMPO (speed) pass. `atempo=<v>` is a
 * pitch-PRESERVING tempo change (no timbre / identity shift), so slowing a clone to
 * v=0.90 lengthens it ~11% without lowering its pitch. We re-assert mono / target
 * sample rate / s16le so the output stays a clean AfterCode-readable WAV. Exported
 * for tests. Runs AFTER ffmpegToMonoS16Wav and BEFORE loudness normalization.
 */
export function buildAtempoArgs(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  v: number,
): string[] {
  return [
    "-y",
    "-i",
    inputPath,
    "-af",
    `atempo=${v}`,
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}

function ffmpegRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function ffmpegAtempo(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  v: number,
): Promise<void> {
  return ffmpegRun(buildAtempoArgs(inputPath, outputPath, sampleRate, v));
}

/**
 * Split normalized speech text into pieces on sentence-ending punctuation (. ? !)
 * and long pauses (em-dash / semicolon / colon), tagging each piece with the pause
 * (seconds) that should FOLLOW it. Sentence-enders => sentencePad; comma/clause
 * separators (, ; : —) => commaPad. The final piece carries no trailing pad (0).
 * Exported for tests. A piece with no detectable terminator keeps the text intact.
 */
export function splitForBreathing(
  text: string,
  sentencePad: number,
  commaPad: number,
): Array<{ text: string; padAfterSeconds: number }> {
  const pieces: Array<{ text: string; padAfterSeconds: number }> = [];
  const sentenceEnders = new Set([".", "?", "!"]);
  const clauseEnders = new Set([";", ":", "—", ","]);
  const closingAfterSentence = new Set([
    '"',
    "'",
    "”",
    "’",
    ")",
    "]",
    "}",
    "»",
  ]);
  let pieceStart = 0;

  const pushPiece = (
    spokenEnd: number,
    nextStart: number,
    padAfterSeconds: number,
  ) => {
    const spoken = text.slice(pieceStart, spokenEnd).trim();
    if (spoken) {
      pieces.push({ text: spoken, padAfterSeconds });
    }
    pieceStart = nextStart;
    while (pieceStart < text.length && /\s/.test(text[pieceStart])) {
      pieceStart += 1;
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (sentenceEnders.has(ch)) {
      let end = i + 1;
      while (end < text.length && sentenceEnders.has(text[end])) {
        end += 1;
      }
      while (end < text.length && closingAfterSentence.has(text[end])) {
        end += 1;
      }
      if (end === text.length || /\s/.test(text[end])) {
        pushPiece(end, end, sentencePad);
        i = pieceStart - 1;
      }
      continue;
    }

    if (commaPad > 0 && clauseEnders.has(ch)) {
      const end = i + 1;
      if (end === text.length || /\s/.test(text[end])) {
        pushPiece(i, end, commaPad);
        i = pieceStart - 1;
      }
    }
  }

  const tail = text.slice(pieceStart).trim();
  if (tail) pieces.push({ text: tail, padAfterSeconds: 0 });

  if (pieces.length > 0) {
    // The last piece ends the utterance — no trailing breath needed.
    pieces[pieces.length - 1].padAfterSeconds = 0;
  } else if (text.trim()) {
    pieces.push({ text: text.trim(), padAfterSeconds: 0 });
  }
  return pieces;
}

/**
 * Build the ffmpeg argv for a PCM (s16le) silence clip of `seconds` duration.
 * CRITICAL: we generate silence as PCM (NOT mp3) so the silence shares the exact
 * WAV codec/rate/layout as the synthesized pieces; this lets the final assembly use
 * `concat -c copy` WITHOUT the non-monotonic-DTS error that an mp3-silence segment
 * triggers on the WAV demuxer path. Exported for tests.
 */
export function buildPcmSilenceArgs(
  outputPath: string,
  seconds: number,
  sampleRate: number,
): string[] {
  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=mono:sample_rate=${sampleRate}`,
    "-t",
    String(seconds),
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}

function escapeConcatPath(filePath: string): string {
  return path.resolve(filePath).replace(/'/g, "'\\''");
}

/**
 * Build the ffmpeg argv for the `concat` demuxer stream-copy over a WAV concat list.
 * `-c copy` is safe ONLY because every entry (pieces + PCM silence) is mono s16le at
 * the same sample rate. Exported for tests.
 */
export function buildWavConcatArgs(
  concatListPath: string,
  outputPath: string,
): string[] {
  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatListPath,
    "-c",
    "copy",
    outputPath,
  ];
}

/**
 * BREATHING stage: re-synthesize the whole-segment text as discrete sentence/clause
 * pieces, mono-s16 each, then concat them interleaved with PCM silence pads so the
 * voice "breathes" between sentences. Profile-gated; runs AFTER atempo, BEFORE
 * loudness. Overwrites `output` in place with the assembled, padded WAV.
 */
async function applyBreathingInPlace(opts: {
  output: string;
  sampleRate: number;
  spokenText: string;
  sentencePad: number;
  commaPad: number;
  daemonUrl: string;
  authToken: string;
  referenceClip: string;
  referenceText: string;
  timeoutMs: number;
  eqHighshelfHz?: number;
  eqHighshelfGainDb?: number;
  atempo?: number;
}): Promise<{ applied: boolean; pieces: number }> {
  const pieces = splitForBreathing(
    opts.spokenText,
    opts.sentencePad,
    opts.commaPad,
  );
  // Nothing to interleave: 0 or 1 piece => leave the whole-segment WAV untouched.
  if (pieces.length < 2) {
    return { applied: false, pieces: pieces.length };
  }

  const dir = path.dirname(opts.output);
  const base = path.basename(opts.output);
  const concatEntries: string[] = [];
  const cleanup: string[] = [];
  try {
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      // Synthesize this piece via the SAME daemon path as the whole segment.
      const audioBuf = await synthesize({
        daemonUrl: opts.daemonUrl,
        authToken: opts.authToken,
        referenceClip: opts.referenceClip,
        referenceText: opts.referenceText,
        text: piece.text,
        timeoutMs: opts.timeoutMs,
      });
      const rawPath = path.join(dir, `${base}.breath-${i}.raw`);
      const wavPath = path.join(dir, `${base}.breath-${i}.wav`);
      cleanup.push(rawPath, wavPath);
      await writeFile(rawPath, audioBuf);
      await ffmpegToMonoS16Wav(rawPath, wavPath, opts.sampleRate, {
        eqHighshelfHz: opts.eqHighshelfHz,
        eqHighshelfGainDb: opts.eqHighshelfGainDb,
      });
      // Apply atempo PER PIECE (before silence) so the speech is sped/slowed but the
      // PCM-silence breaths keep their EXACT profile pad durations.
      if (opts.atempo !== undefined) {
        const tempoPath = path.join(dir, `${base}.breath-${i}.tempo.wav`);
        cleanup.push(tempoPath);
        await ffmpegAtempo(wavPath, tempoPath, opts.sampleRate, opts.atempo);
        concatEntries.push(tempoPath);
      } else {
        concatEntries.push(wavPath);
      }
      // Interleave a PCM-silence breath after every piece except the last.
      if (piece.padAfterSeconds > 0 && i < pieces.length - 1) {
        const silPath = path.join(dir, `${base}.sil-${i}.wav`);
        cleanup.push(silPath);
        await ffmpegRun(
          buildPcmSilenceArgs(silPath, piece.padAfterSeconds, opts.sampleRate),
        );
        concatEntries.push(silPath);
      }
    }

    const listPath = path.join(dir, `${base}.breath.concat.txt`);
    cleanup.push(listPath);
    await writeFile(
      listPath,
      concatEntries.map((p) => `file '${escapeConcatPath(p)}'`).join("\n"),
      "utf8",
    );
    const assembled = path.join(dir, `${base}.breath.out.wav`);
    cleanup.push(assembled);
    await ffmpegRun(buildWavConcatArgs(listPath, assembled));
    await rename(assembled, opts.output);
    // `assembled` was renamed onto output; drop it from cleanup-removal set.
    cleanup.splice(cleanup.indexOf(assembled), 1);
    return { applied: true, pieces: pieces.length };
  } finally {
    const { unlink } = await import("node:fs/promises");
    for (const p of cleanup) {
      try {
        await unlink(p);
      } catch {
        /* best effort */
      }
    }
  }
}

/** Measure a WAV's mean_volume (dB) via ffmpeg volumedetect; null if unmeasurable. */
function measureMeanVolumeDb(inputPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        inputPath,
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    ff.on("error", () => resolve(null));
    ff.on("close", () => {
      const match = stderr.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
      if (!match) {
        resolve(null);
        return;
      }
      const value = Number.parseFloat(match[1]);
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}

function ffmpegLoudnessNormalize(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  gainDb: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      buildLoudnessNormalizeArgs(inputPath, outputPath, sampleRate, gainDb),
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * 2-pass RMS loudness normalize: measure the WAV's mean_volume, compute the gain
 * to hit targetDb, then re-encode applying that gain + a limiter into a temp file
 * and rename over the output. Runs AFTER the highshelf EQ pass so the final body
 * RMS is exactly the target regardless of the EQ tone shaping (→ consistent across
 * segments). No-op (returns false) if the volume could not be measured.
 */
async function loudnessNormalizeInPlace(
  output: string,
  sampleRate: number,
  targetDb: number,
): Promise<{ applied: boolean; measuredDb?: number; gainDb?: number }> {
  const measuredDb = await measureMeanVolumeDb(output);
  if (measuredDb === null) {
    return { applied: false };
  }
  const gainDb = computeLoudnessGainDb(measuredDb, targetDb);
  const tmpPath = `${output}.loud.wav`;
  await ffmpegLoudnessNormalize(output, tmpPath, sampleRate, gainDb);
  await rename(tmpPath, output);
  return { applied: true, measuredDb, gainDb };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.text || !args.text.trim())
    fail("--text is required and must be non-empty");
  if (!args.output) fail("--output is required");
  if (!Number.isFinite(args.sampleRate) || args.sampleRate <= 0)
    fail(`invalid --sample-rate: ${args.sampleRate}`);

  const resolved = await resolveReference(args);

  const authTokenPath = path.resolve(expandHome(resolved.authTokenFile));
  if (!existsSync(authTokenPath))
    fail(`daemon auth token file not found: ${authTokenPath}`);
  const authToken = (await readFile(authTokenPath, "utf8")).trim();
  if (!authToken) fail(`daemon auth token file is empty: ${authTokenPath}`);

  const output = path.resolve(expandHome(args.output));
  await mkdir(path.dirname(output), { recursive: true });

  // Pronunciation normalization (the TERM_MAP respellings) MUST happen here,
  // before the daemon, exactly as renderSegment does. The DISPLAY is unaffected:
  // the build reads the script .md, not this runner's TTS-feed text.
  const spokenText = normalizeForSpeech(args.text);

  // PRONUNCIATION SIDECAR: write the LITERAL bytes sent to the daemon next to the
  // output as <output>.spoken.txt, so the gate's Check 0 can diff the spoken feed
  // against the displayed script. Best-effort: a sidecar write failure never blocks
  // synthesis.
  try {
    await writeFile(`${output}.spoken.txt`, spokenText, "utf8");
  } catch {
    /* best effort: sidecar is diagnostic, not load-bearing for audio */
  }

  // CONTENT-HASH FREEZE (determinism layer). The key is computed over the literal
  // spoken text + reference identity + the OUTPUT-affecting synth params. On a HIT
  // we copy the FROZEN accepted take to the output and skip the non-deterministic
  // daemon entirely; on a MISS we synth normally, then store the final WAV under the
  // key — freezing this take for every future identical request.
  const cacheParams: CacheKeyParams = {
    eqHighshelfHz: resolved.eqHighshelfHz,
    eqHighshelfGainDb: resolved.eqHighshelfGainDb,
    loudnessTargetDb: resolved.loudnessTargetDb,
    atempo: resolved.atempo,
    sentencePauseSeconds: resolved.sentencePauseSeconds,
    commaPauseSeconds: resolved.commaPauseSeconds,
  };
  const cacheDir = path.resolve(
    expandHome(args.cacheDir ?? "~/.narrationlayer/tts-cache"),
  );
  const cacheKey = computeContentHashKey({
    spokenText,
    referenceClip: resolved.referenceClip,
    referenceText: resolved.referenceText,
    profileId: resolved.profileId,
    profileVersion: resolved.profileVersion,
    model: resolved.model,
    params: cacheParams,
  });
  const cachePath = path.join(cacheDir, `${cacheKey}.wav`);
  if (args.cache && existsSync(cachePath)) {
    await copyFile(cachePath, output);
    const hitInfo = await stat(output).catch(() => undefined);
    if (!hitInfo || hitInfo.size === 0) {
      fail(`cache HIT but frozen WAV is empty or unreadable: ${cachePath}`);
    }
    process.stderr.write(
      `local-tts-runner: cache HIT key=${cacheKey} role=${args.role ?? "-"} via ${resolved.source} -> ${output} (${hitInfo.size} bytes, frozen take ${cachePath})\n`,
    );
    process.exit(0);
  }

  const audioBuf = await synthesize({
    daemonUrl: resolved.daemonUrl,
    authToken,
    referenceClip: resolved.referenceClip,
    referenceText: resolved.referenceText,
    model: resolved.model,
    text: spokenText,
    timeoutMs: args.timeoutMs,
  });

  // Write raw daemon audio to a temp file beside output, then transcode to mono s16 WAV.
  const rawPath = `${output}.raw`;
  await writeFile(rawPath, audioBuf);
  try {
    await ffmpegToMonoS16Wav(rawPath, output, args.sampleRate, {
      eqHighshelfHz: resolved.eqHighshelfHz,
      eqHighshelfGainDb: resolved.eqHighshelfGainDb,
    });
  } finally {
    try {
      await (await import("node:fs/promises")).unlink(rawPath);
    } catch {
      /* best effort */
    }
  }

  // PER-PROFILE ATEMPO (speed) + BREATHING (pauses), applied AFTER the mono-s16 pass
  // (so they share the EQ'd body) and BEFORE loudness normalization.
  //   - atempo: pitch-PRESERVING tempo change (no timbre / identity shift).
  //   - breathing: re-synthesize the segment as sentence/clause pieces and interleave
  //     PCM-silence breaths.
  // When breathing is active it applies atempo PER PIECE (so the silence pads keep
  // their EXACT profile durations); the standalone atempo pass below runs ONLY when
  // breathing did not assemble (so a non-breathing profile still gets its speed change).
  let atempoNote =
    resolved.atempo !== undefined ? ` atempo=${resolved.atempo}` : "";
  let breathingNote = "";
  let breathingApplied = false;
  if (
    resolved.sentencePauseSeconds !== undefined ||
    resolved.commaPauseSeconds !== undefined
  ) {
    const sentencePad = resolved.sentencePauseSeconds ?? 0.55;
    const commaPad = resolved.commaPauseSeconds ?? 0.22;
    const breath = await applyBreathingInPlace({
      output,
      sampleRate: args.sampleRate,
      spokenText,
      sentencePad,
      commaPad,
      daemonUrl: resolved.daemonUrl,
      authToken,
      referenceClip: resolved.referenceClip,
      referenceText: resolved.referenceText,
      timeoutMs: args.timeoutMs,
      eqHighshelfHz: resolved.eqHighshelfHz,
      eqHighshelfGainDb: resolved.eqHighshelfGainDb,
      atempo: resolved.atempo,
    });
    breathingApplied = breath.applied;
    breathingNote = breath.applied
      ? ` breathing=${breath.pieces}pc(sent=${sentencePad}s,comma=${commaPad}s)`
      : ` breathing=skipped(${breath.pieces}pc)`;
  }

  // Standalone atempo: only when breathing did NOT assemble (breathing applies atempo
  // per-piece internally). atempo unset => skipped (behavior unchanged).
  if (resolved.atempo !== undefined && !breathingApplied) {
    const tmpPath = `${output}.atempo.wav`;
    try {
      await ffmpegAtempo(output, tmpPath, args.sampleRate, resolved.atempo);
      await rename(tmpPath, output);
    } catch (err) {
      try {
        await (await import("node:fs/promises")).unlink(tmpPath);
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  // Loudness normalization (profile-gated). Order matters: highshelf EQ ran FIRST
  // (above, shaping the tone), THEN we RMS-normalize so the final body is exactly
  // the target regardless of the EQ — making body loudness consistent across every
  // segment. Unset target => behavior unchanged (skipped).
  let loudnessNote = "";
  if (resolved.loudnessTargetDb !== undefined) {
    const norm = await loudnessNormalizeInPlace(
      output,
      args.sampleRate,
      resolved.loudnessTargetDb,
    );
    loudnessNote = norm.applied
      ? ` loudness=${resolved.loudnessTargetDb}dB (measured ${norm.measuredDb?.toFixed(2)}dB, gain ${norm.gainDb?.toFixed(2)}dB)`
      : ` loudness=${resolved.loudnessTargetDb}dB (skipped: unmeasurable)`;
  }

  const info = await stat(output).catch(() => undefined);
  if (!info || info.size === 0)
    fail(`output WAV is empty or missing: ${output}`);

  // CONTENT-HASH FREEZE (MISS): store the FINAL processed WAV under the key so this
  // accepted take is frozen for every future identical request. Best-effort: a cache
  // store failure must never fail an otherwise-good synth. Atomic via temp+rename so a
  // crash mid-write never leaves a truncated frozen take.
  let cacheNote = "";
  if (args.cache) {
    try {
      await mkdir(cacheDir, { recursive: true });
      const cacheTmp = `${cachePath}.tmp-${process.pid}`;
      await copyFile(output, cacheTmp);
      await rename(cacheTmp, cachePath);
      cacheNote = ` cache MISS->frozen key=${cacheKey}`;
    } catch {
      cacheNote = ` cache MISS (store failed key=${cacheKey})`;
    }
  }

  process.stderr.write(
    `local-tts-runner: ok role=${args.role ?? "-"} via ${resolved.source} -> ${output} (${info.size} bytes, mono s16 @ ${args.sampleRate}Hz)${atempoNote}${breathingNote}${loudnessNote}${cacheNote}\n`,
  );
  process.exit(0);
}

// Run as a CLI only when invoked directly; importing this module (e.g. in
// tests, to reuse buildMonoS16WavArgs) must NOT execute the runner.
if (import.meta.main) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

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
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { synthesizeQwen3, Qwen3DaemonError } from "../src/backends/qwen3-daemon.js";
import { findProfile, qwenConfigFromProfile, warnIfNonAcceptedProfile } from "../src/profiles.js";
import { prepareSpeechChannels as prepareDefaultChannels, type TermRule, type SpeechChannels } from "../src/text-normalize.js";

import {
  buildMonoS16WavArgs,
  computeLoudnessGainDb,
  buildLoudnessNormalizeArgs,
  buildAtempoArgs,
  buildPcmSilenceArgs,
  escapeConcatPath,
  buildWavConcatArgs,
  type MonoS16WavOptions,
} from "../src/audio/ffmpeg-args.js";
import { splitForBreathing } from "../src/plan/breathing.js";
import {
  computeContentHashKey,
  writeTakeCacheReceipt,
  clearTakeCacheReceipt,
  type CacheKeyParams,
} from "../src/pipelines/local-tts/take-cache.js";

export {
  buildMonoS16WavArgs,
  computeLoudnessGainDb,
  buildLoudnessNormalizeArgs,
  buildAtempoArgs,
  buildPcmSilenceArgs,
  buildWavConcatArgs,
} from "../src/audio/ffmpeg-args.js";
export { splitForBreathing } from "../src/plan/breathing.js";
export {
  type CacheKeyParams,
  computeContentHashKey,
  writeTakeCacheReceipt,
  clearTakeCacheReceipt,
} from "../src/pipelines/local-tts/take-cache.js";

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
  try {
    const payload = await synthesizeQwen3({
      url: `${opts.daemonUrl.replace(/\/+$/, "")}/synthesize`,
      authToken: opts.authToken,
      body: {
        text: opts.text,
        reference_wav: opts.referenceClip,
        reference_text: opts.referenceText,
        ...(opts.model ? { model: opts.model } : {}),
      },
      timeoutMs: opts.timeoutMs,
    });
    return Buffer.from(payload.audioBase64, "base64");
  } catch (error) {
    if (!(error instanceof Qwen3DaemonError)) throw error;
    const failure = error.failure;
    if (failure.kind === "http") {
      fail(
        `daemon /synthesize failed (${failure.status}): ${failure.body || failure.statusText}`,
      );
    }
    if (failure.kind === "missing-audio") fail("daemon response missing audio_b64");
    throw failure.cause;
  }
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

export type SpeechPreparation = (text: string, pronunciationRules: TermRule[]) => SpeechChannels;
const defaultPrepareSpeechChannels: SpeechPreparation = prepareDefaultChannels;

export async function main(prepareSpeechChannels = defaultPrepareSpeechChannels): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.text || !args.text.trim())
    fail("--text is required and must be non-empty");
  if (!args.output) fail("--output is required");
  if (!Number.isFinite(args.sampleRate) || args.sampleRate <= 0)
    fail(`invalid --sample-rate: ${args.sampleRate}`);

  const output = path.resolve(expandHome(args.output));
  await mkdir(path.dirname(output), { recursive: true });
  await clearTakeCacheReceipt(output);

  const resolved = await resolveReference(args);

  const authTokenPath = path.resolve(expandHome(resolved.authTokenFile));
  if (!existsSync(authTokenPath))
    fail(`daemon auth token file not found: ${authTokenPath}`);
  const authToken = (await readFile(authTokenPath, "utf8")).trim();
  if (!authToken) fail(`daemon auth token file is empty: ${authTokenPath}`);

  // Pronunciation normalization (the TERM_MAP respellings) MUST happen here,
  // before the daemon, exactly as renderSegment does. The DISPLAY is unaffected:
  // the build reads the script .md, not this runner's TTS-feed text.
  const channels = prepareSpeechChannels(args.text, []);
  const spokenText = channels?.synthInput;
  if (typeof spokenText !== "string" || !spokenText.trim())
    fail("speech preparation must return a nonblank synthInput string synchronously");

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
    // Commit synth provenance only after the selected WAV is known non-empty.
    // A failed rerun must never pair new sidecar bytes with an older output.
    await writeFile(`${output}.spoken.txt`, spokenText, "utf8");
    await writeTakeCacheReceipt(output, cacheKey, { cacheEnabled: args.cache });
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

  // Persist the literal daemon input only after every output-affecting pass and
  // final non-empty validation has succeeded. Downstream gates derive approved
  // aliases from these bytes, so publishing them before the WAV is accepted is unsafe.
  await writeFile(`${output}.spoken.txt`, spokenText, "utf8");
  await writeTakeCacheReceipt(output, cacheKey, { cacheEnabled: args.cache });

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

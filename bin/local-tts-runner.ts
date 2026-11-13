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

import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { findProfile, qwenConfigFromProfile, warnIfNonAcceptedProfile } from "../src/profiles.js";
import { prepareSpeechChannels as prepareDefaultChannels, type TermRule, type SpeechChannels } from "../src/text-normalize.js";
import { clearTakeCacheReceipt } from "../src/pipelines/local-tts/take-cache.js";
import { RunnerFailure } from "../src/pipelines/local-tts/failure.js";
import { renderLocalTts, type LocalTtsRenderResult } from "../src/pipelines/local-tts/index.js";

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
  /** Render even on a HIT and replace the cached take (--refresh-cache). */
  refreshCache: boolean;
  /** Keep each joined piece and pieces.json here (--keep-pieces <dir>). */
  keepPieces?: string;
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
  const args: Args = { sampleRate: 24000, timeoutMs: 120_000, cache: true, refreshCache: false };
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
      case "--refresh-cache":
        args.refreshCache = true;
        break;
      case "--keep-pieces":
        args.keepPieces = takeValue();
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
  if (args.refreshCache && !args.cache)
    fail("--refresh-cache cannot be combined with --no-cache (a refresh stores the new take in the cache)");
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
  --refresh-cache            Render a fresh take even on a HIT, then replace the cached
                             take with it (atomically; a failed render keeps the old one).
                             The receipt <output>.cache.json says cacheRefreshed. Not
                             allowed with --no-cache.
  --keep-pieces <dir>        Copy each piece's audio as it was joined (before loudness)
                             to <dir>/piece-NNN.wav and write <dir>/pieces.json (text,
                             samples, duration, pause after, offset). An uncut render
                             keeps one piece. <dir> must not exist or must be empty. On
                             a cache HIT nothing is rendered, so none are written; the
                             receipt says so. Neither switch changes the audio or key.

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

  let result: LocalTtsRenderResult;
  try {
    result = await renderLocalTts({
      text: args.text,
      output,
      sampleRate: args.sampleRate,
      resolved,
      authToken,
      cacheDir: path.resolve(expandHome(args.cacheDir ?? "~/.narrationlayer/tts-cache")),
      cache: args.cache,
      refreshCache: args.refreshCache,
      keepPiecesDir: args.keepPieces === undefined ? undefined : path.resolve(expandHome(args.keepPieces)),
      timeoutMs: args.timeoutMs,
      prepareSpeechChannels,
    });
  } catch (err) {
    if (err instanceof RunnerFailure) fail(err.message);
    throw err;
  }
  if (result.kind === "cache-hit") {
    process.stderr.write(
      `local-tts-runner: cache HIT key=${result.cacheKey} role=${args.role ?? "-"} via ${resolved.source} -> ${output} (${result.bytes} bytes, frozen take ${result.cachePath})${result.piecesNote}\n`,
    );
    process.exit(0);
  }
  process.stderr.write(
    `local-tts-runner: ok role=${args.role ?? "-"} via ${resolved.source} -> ${output} (${result.bytes} bytes, mono s16 @ ${args.sampleRate}Hz)${result.atempoNote}${result.breathingNote}${result.loudnessNote}${result.cacheNote}${result.piecesNote}\n`,
  );
  process.exit(0);
}

// Run as a CLI only when invoked directly; importing this module (e.g. in
// tests, to reuse buildMonoS16WavArgs) must NOT execute the runner.
if (import.meta.main) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

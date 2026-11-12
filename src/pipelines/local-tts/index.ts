import { writeFile, mkdir, stat, rename, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SpeechChannels, TermRule } from "../../text-normalize.js";
import { ffmpegToMonoS16Wav, ffmpegAtempo } from "../../audio/ffmpeg-run.js";
import { synthesize } from "./synthesis.js";
import { RunnerFailure } from "./failure.js";
import { applyBreathingInPlace } from "./breathing.js";
import { loudnessNormalizeInPlace } from "./loudness.js";
import { computeContentHashKey, writeTakeCacheReceipt, type CacheKeyParams } from "./take-cache.js";

export interface ResolvedLocalTtsVoice extends CacheKeyParams {
  referenceClip: string;
  referenceText: string;
  daemonUrl: string;
  profileId?: string;
  profileVersion?: string;
  model?: string;
}

export interface LocalTtsRenderOptions {
  text: string;
  output: string;
  sampleRate: number;
  resolved: ResolvedLocalTtsVoice;
  authToken: string;
  cacheDir: string;
  cache: boolean;
  timeoutMs: number;
  prepareSpeechChannels: (text: string, pronunciationRules: TermRule[]) => SpeechChannels;
}

export type LocalTtsRenderResult =
  | { kind: "cache-hit"; cacheKey: string; cachePath: string; bytes: number }
  | { kind: "rendered"; cacheKey: string; bytes: number; atempoNote: string; breathingNote: string; loudnessNote: string; cacheNote: string };

/** Render one resolved voice configuration without owning the caller's process. */
export async function renderLocalTts(args: LocalTtsRenderOptions): Promise<LocalTtsRenderResult> {
  const { output, resolved, authToken, cacheDir, prepareSpeechChannels } = args;
  // Pronunciation normalization (the TERM_MAP respellings) MUST happen here,
  // before the daemon, exactly as renderSegment does. The DISPLAY is unaffected:
  // the build reads the script .md, not this runner's TTS-feed text.
  const channels = prepareSpeechChannels(args.text, []);
  const spokenText = channels?.synthInput;
  if (typeof spokenText !== "string" || !spokenText.trim())
    throw new RunnerFailure("speech preparation must return a nonblank synthInput string synchronously");

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
      throw new RunnerFailure(`cache HIT but frozen WAV is empty or unreadable: ${cachePath}`);
    }
    // Commit synth provenance only after the selected WAV is known non-empty.
    // A failed rerun must never pair new sidecar bytes with an older output.
    await writeFile(`${output}.spoken.txt`, spokenText, "utf8");
    await writeTakeCacheReceipt(output, cacheKey, { cacheEnabled: args.cache });
    return { kind: "cache-hit", cacheKey, cachePath, bytes: hitInfo.size };
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
    throw new RunnerFailure(`output WAV is empty or missing: ${output}`);

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

  return { kind: "rendered", cacheKey, bytes: info.size, atempoNote, breathingNote, loudnessNote, cacheNote };
}

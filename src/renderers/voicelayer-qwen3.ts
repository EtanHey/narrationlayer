import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

import { assembleAudioWithSilence, trimAudioSilence, applyAudioEq, type AudioAssemblyChunk } from "../audio.js";
import { probeAudioDurationSeconds } from "../audio.js";
import { planNarrationUtterances, type NarrationPacingConfig } from "../narration-plan.js";
import type { RenderManifestSegment, TimingSource, WordTiming, WordsFile } from "../schema.js";
import { normalizeForSpeech } from "../text-normalize.js";
import type { RenderSegmentOptions } from "./types.js";
import { runWhisperCliWordTimings, type WordTimingResult } from "../word-timings.js";
import { normalizeWordTimingsForScript } from "../word-timing-repair.js";

export interface VoiceLayerQwen3Config extends NarrationPacingConfig {
  profile_id?: string;
  profile_version?: string;
  reference_clip_sha?: string;
  model?: string;
  narrationlayer_commit?: string;
  daemon_url?: string;
  auth_token?: string;
  auth_token_file?: string;
  reference_clip?: string;
  reference_text?: string;
  reference_text_path?: string;
  reference_clips?: string[];
  lora_adapter_path?: string;
  lora_scale?: number;
  timeout_ms?: number;
  timing_backend?: "none" | "whisper-cli";
  whisper_binary?: string;
  whisper_model?: string;
  trim_silence?: boolean;
  silence_threshold_db?: number;
  eq_highshelf_hz?: number;
  eq_highshelf_gain_db?: number;
  loudness_target_db?: number;
  atempo?: number;
  silence_padding_seconds?: number;
  repair_word_timings?: boolean;
  max_chunk_duration_seconds?: number;
  max_chunk_seconds_per_word?: number;
  max_chunk_retries?: number;
  audio_duration_probe?: (audioPath: string) => Promise<number | undefined>;
  audio_postprocessor?: (args: { inputPath: string; outputPath: string }) => Promise<void>;
  audio_assembler?: (args: { chunks: AudioAssemblyChunk[]; outputPath: string }) => Promise<void>;
  word_timing_provider?: (args: {
    audioPath: string;
    script: string;
    durationSeconds: number;
  }) => Promise<WordTiming[] | WordTimingResult>;
}

interface VoiceLayerTimingCandidate {
  index?: unknown;
  word?: unknown;
  text?: unknown;
  start?: unknown;
  end?: unknown;
  start_seconds?: unknown;
  end_seconds?: unknown;
  offset_ms?: unknown;
  duration_ms?: unknown;
  confidence?: unknown;
}

interface VoiceLayerSynthesizeResponse {
  audio_b64?: unknown;
  duration_ms?: unknown;
  audio_duration_ms?: unknown;
  words?: unknown;
  word_timings?: unknown;
  word_boundaries?: unknown;
  lora_applied?: unknown;
}

const DEFAULT_MAX_CHUNK_DURATION_SECONDS = 45;
const DEFAULT_MAX_CHUNK_SECONDS_PER_WORD = 3;
const DEFAULT_MIN_CHUNK_DURATION_SECONDS = 30;
const DEFAULT_MAX_CHUNK_RETRIES = 1;

class RunawayGeneratedChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunawayGeneratedChunkError";
  }
}

export function getWordsFromScript(script: string): string[] {
  return script
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function expandHome(value: string): string {
  if (value === "~") {
    return process.env.HOME || value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME || "~", value.slice(2));
  }
  return value;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function coerceTiming(candidate: VoiceLayerTimingCandidate, index: number): WordTiming | null {
  const word = typeof candidate.word === "string" ? candidate.word : typeof candidate.text === "string" ? candidate.text : "";
  if (!word.trim()) {
    return null;
  }

  const offsetMs = coerceNumber(candidate.offset_ms);
  const durationMs = coerceNumber(candidate.duration_ms);
  const start =
    coerceNumber(candidate.start) ??
    coerceNumber(candidate.start_seconds) ??
    (offsetMs === undefined ? undefined : offsetMs / 1000);
  const end =
    coerceNumber(candidate.end) ??
    coerceNumber(candidate.end_seconds) ??
    (offsetMs === undefined || durationMs === undefined ? undefined : (offsetMs + durationMs) / 1000);

  if (start === undefined || end === undefined) {
    return null;
  }

  const confidence = coerceNumber(candidate.confidence);
  return {
    index: coerceNumber(candidate.index) ?? index,
    word,
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function normalizeReturnedTimings(payload: VoiceLayerSynthesizeResponse): WordTiming[] {
  const raw = payload.word_timings ?? payload.words ?? payload.word_boundaries;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((candidate, index) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return null;
      }
      return coerceTiming(candidate as VoiceLayerTimingCandidate, index);
    })
    .filter((timing): timing is WordTiming => timing !== null);
}

function normalizeDuration(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Number(value.toFixed(3));
}

function cleanPositive(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function cleanNonNegativeInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : Math.floor(value);
}

function getGeneratedChunkDurationLimitSeconds(text: string, config: VoiceLayerQwen3Config): number {
  const wordCount = Math.max(1, getWordsFromScript(text).length);
  const absoluteLimit = cleanPositive(config.max_chunk_duration_seconds, DEFAULT_MAX_CHUNK_DURATION_SECONDS);
  const secondsPerWord = cleanPositive(config.max_chunk_seconds_per_word, DEFAULT_MAX_CHUNK_SECONDS_PER_WORD);
  return Number(Math.min(absoluteLimit, Math.max(DEFAULT_MIN_CHUNK_DURATION_SECONDS, wordCount * secondsPerWord)).toFixed(3));
}

async function getGeneratedChunkDurationSeconds(args: {
  payload: VoiceLayerSynthesizeResponse;
  audioPath: string;
  config: VoiceLayerQwen3Config;
}): Promise<number | undefined> {
  return (
    normalizeDuration(await (args.config.audio_duration_probe ?? probeAudioDurationSeconds)(args.audioPath)) ??
    getPayloadDurationSeconds(args.payload)
  );
}

async function assertGeneratedChunkDuration(args: {
  segmentId: string;
  chunkIndex: number;
  text: string;
  payload: VoiceLayerSynthesizeResponse;
  audioPath: string;
  config: VoiceLayerQwen3Config;
}): Promise<void> {
  const durationSeconds = await getGeneratedChunkDurationSeconds(args);
  if (durationSeconds === undefined) {
    return;
  }
  const limitSeconds = getGeneratedChunkDurationLimitSeconds(args.text, args.config);
  if (durationSeconds <= limitSeconds) {
    return;
  }
  const wordCount = getWordsFromScript(args.text).length;
  throw new RunawayGeneratedChunkError(
    `voicelayer-qwen3 runaway generated chunk: segment=${args.segmentId} chunk=${args.chunkIndex + 1} duration=${durationSeconds}s limit=${limitSeconds}s words=${wordCount} text=${JSON.stringify(args.text)}`,
  );
}

async function synthesizeText(args: {
  daemonUrl: string;
  authToken: string;
  referenceClip: string;
  referenceText: string;
  loraAdapterPath?: string;
  loraScale?: number;
  model?: string;
  text: string;
  fetchImpl: NonNullable<RenderSegmentOptions["fetch"]>;
  timeoutMs: number;
}): Promise<VoiceLayerSynthesizeResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  let response: Response;
  try {
    response = await args.fetchImpl(`${args.daemonUrl}/synthesize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.authToken}`,
      },
      body: JSON.stringify({
        text: args.text,
        reference_wav: args.referenceClip,
        reference_text: args.referenceText,
        ...(args.model ? { model: args.model } : {}),
        ...(args.loraAdapterPath ? { lora_adapter_path: args.loraAdapterPath } : {}),
        ...(args.loraScale === undefined ? {} : { lora_scale: args.loraScale }),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`voicelayer-qwen3 synthesize failed (${response.status}): ${body || response.statusText}`);
  }

  const payload = (await response.json()) as VoiceLayerSynthesizeResponse;
  if (typeof payload.audio_b64 !== "string" || !payload.audio_b64) {
    throw new Error("voicelayer-qwen3 response missing audio_b64");
  }
  if (args.loraAdapterPath && payload.lora_applied !== true) {
    throw new Error("voicelayer-qwen3 daemon did not confirm LoRA adapter application");
  }
  return payload;
}

function getPayloadDurationSeconds(payload: VoiceLayerSynthesizeResponse): number | undefined {
  const payloadDurationMs = coerceNumber(payload.audio_duration_ms) ?? coerceNumber(payload.duration_ms);
  return payloadDurationMs === undefined ? undefined : normalizeDuration(payloadDurationMs / 1000);
}

async function loadAuthToken(config: VoiceLayerQwen3Config): Promise<string | undefined> {
  if (config.auth_token?.trim()) {
    return config.auth_token.trim();
  }
  const tokenFile =
    config.auth_token_file ||
    process.env.VOICELAYER_TTS_DAEMON_SECRET_FILE ||
    process.env.VOICELAYER_TTS_AUTH_TOKEN_FILE;
  if (!tokenFile) {
    return undefined;
  }
  return (await readFile(path.resolve(expandHome(tokenFile)), "utf8")).trim();
}

async function loadReferenceText(config: VoiceLayerQwen3Config): Promise<string> {
  if (config.reference_text?.trim()) {
    return config.reference_text.trim();
  }
  if (!config.reference_text_path?.trim()) {
    throw new Error("voicelayer-qwen3 requires reference_text or reference_text_path");
  }
  return (await readFile(path.resolve(expandHome(config.reference_text_path)), "utf8")).trim();
}

function getReferenceClip(config: VoiceLayerQwen3Config): string {
  const referenceClip = config.reference_clip || config.reference_clips?.[0];
  if (!referenceClip?.trim()) {
    throw new Error("voicelayer-qwen3 requires reference_clip or reference_clips");
  }
  return path.resolve(expandHome(referenceClip));
}

let narrationlayerCommitCache: string | undefined;

function getNarrationLayerCommit(config: VoiceLayerQwen3Config): string {
  if (config.narrationlayer_commit?.trim()) {
    return config.narrationlayer_commit.trim();
  }
  if (process.env.NARRATIONLAYER_COMMIT?.trim()) {
    return process.env.NARRATIONLAYER_COMMIT.trim();
  }
  if (narrationlayerCommitCache !== undefined) {
    return narrationlayerCommitCache;
  }
  const result = Bun.spawnSync({
    cmd: ["git", "rev-parse", "HEAD"],
    cwd: path.resolve(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  narrationlayerCommitCache =
    result.exitCode === 0 ? result.stdout.toString().trim() || "unknown" : "unknown";
  return narrationlayerCommitCache;
}

async function getReferenceClipSha(config: VoiceLayerQwen3Config, referenceClip: string): Promise<string> {
  if (config.reference_clip_sha?.trim()) {
    return config.reference_clip_sha.trim();
  }
  try {
    return createHash("sha256").update(await readFile(referenceClip)).digest("hex");
  } catch {
    return "unknown";
  }
}

export async function renderSegment(
  segmentId: string,
  segment: { title: string; script: string; duration_seconds?: number },
  options: RenderSegmentOptions,
  config: VoiceLayerQwen3Config,
): Promise<RenderManifestSegment> {
  const normalizedScript = normalizeForSpeech(segment.script);
  const daemonUrl = (config.daemon_url || "http://127.0.0.1:8880").replace(/\/+$/, "");
  const authToken = await loadAuthToken(config);
  if (!authToken) {
    throw new Error("voicelayer-qwen3 requires auth_token or auth_token_file");
  }
  const referenceClip = getReferenceClip(config);
  const referenceText = await loadReferenceText(config);

  const fetchImpl = options.fetch ?? fetch;
  const artifactsRoot = path.join(options.artifactsDir, "segments", segmentId);
  await mkdir(artifactsRoot, { recursive: true });
  const audioPath = path.join(artifactsRoot, `${segmentId}.mp3`);
  const wordsPath = path.join(artifactsRoot, "words.json");
  const plannedUtterances = planNarrationUtterances(normalizedScript, config);
  const shouldTrim = config.trim_silence === true;
  const chunksRoot = path.join(artifactsRoot, "chunks");
  const shouldAssemble = plannedUtterances.length > 1 || plannedUtterances.some((item) => item.pause_after_seconds > 0);
  if (shouldAssemble || shouldTrim) {
    await mkdir(chunksRoot, { recursive: true });
  }

  const audioChunks: AudioAssemblyChunk[] = [];
  let lastPayload: VoiceLayerSynthesizeResponse | undefined;
  let fallbackDurationSeconds = 0;
  const maxChunkRetries = cleanNonNegativeInteger(config.max_chunk_retries, DEFAULT_MAX_CHUNK_RETRIES);
  for (let index = 0; index < plannedUtterances.length; index += 1) {
    const utterance = plannedUtterances[index];
    let acceptedPayload: VoiceLayerSynthesizeResponse | undefined;
    let acceptedChunkPath: string | undefined;
    for (let attempt = 0; attempt <= maxChunkRetries; attempt += 1) {
      const payload = await synthesizeText({
        daemonUrl,
        authToken,
        referenceClip,
        referenceText,
        loraAdapterPath: config.lora_adapter_path ? path.resolve(expandHome(config.lora_adapter_path)) : undefined,
        loraScale: config.lora_scale,
        model: config.model,
        text: utterance.text,
        fetchImpl,
        timeoutMs: config.timeout_ms ?? 30_000,
      });
      const suffix = attempt === 0 ? `${segmentId}-${index + 1}` : `${segmentId}-${index + 1}.retry-${attempt}`;
      const rawChunkPath = shouldTrim
        ? path.join(chunksRoot, `${suffix}.raw.mp3`)
        : shouldAssemble
          ? path.join(chunksRoot, `${suffix}.mp3`)
          : audioPath;
      await writeFile(rawChunkPath, Buffer.from(payload.audio_b64 as string, "base64"));
      const chunkPath = shouldTrim
        ? shouldAssemble
          ? path.join(chunksRoot, `${suffix}.mp3`)
          : audioPath
        : rawChunkPath;
      if (shouldTrim) {
        await (config.audio_postprocessor ??
          ((args) =>
            trimAudioSilence(args.inputPath, args.outputPath, {
              thresholdDb: config.silence_threshold_db,
              stopSilenceSeconds: config.silence_padding_seconds,
            })))({
          inputPath: rawChunkPath,
          outputPath: chunkPath,
        });
      }
      if (config.eq_highshelf_hz !== undefined || config.eq_highshelf_gain_db !== undefined) {
        const eqPath = `${chunkPath}.eq.mp3`;
        await applyAudioEq(chunkPath, eqPath, {
          highshelfHz: config.eq_highshelf_hz,
          highshelfGainDb: config.eq_highshelf_gain_db,
        });
        await rename(eqPath, chunkPath);
      }
      try {
        await assertGeneratedChunkDuration({
          segmentId,
          chunkIndex: index,
          text: utterance.text,
          payload,
          audioPath: chunkPath,
          config,
        });
        acceptedPayload = payload;
        acceptedChunkPath = chunkPath;
        break;
      } catch (error) {
        if (error instanceof RunawayGeneratedChunkError && attempt < maxChunkRetries) {
          continue;
        }
        throw error;
      }
    }
    if (!acceptedPayload || !acceptedChunkPath) {
      throw new Error(`voicelayer-qwen3 failed to synthesize chunk ${index + 1} for segment ${segmentId}`);
    }
    lastPayload = acceptedPayload;
    audioChunks.push({
      audioPath: acceptedChunkPath,
      pauseAfterSeconds: utterance.pause_after_seconds,
    });
    fallbackDurationSeconds += (getPayloadDurationSeconds(acceptedPayload) ?? 0) + utterance.pause_after_seconds;
  }

  if (shouldAssemble) {
    await (config.audio_assembler ?? ((args) => assembleAudioWithSilence(args.chunks, args.outputPath)))({
      chunks: audioChunks,
      outputPath: audioPath,
    });
  }

  const measuredDuration =
    segment.duration_seconds ??
    normalizeDuration(await (config.audio_duration_probe ?? probeAudioDurationSeconds)(audioPath)) ??
    normalizeDuration(fallbackDurationSeconds) ??
    0;

  let returnedTimings = shouldAssemble || !lastPayload ? [] : normalizeReturnedTimings(lastPayload);
  let timingSource: TimingSource = "voicelayer-qwen3";
  let timingUnavailableReason = "backend_did_not_return_word_timings";
  if (returnedTimings.length === 0 && config.word_timing_provider) {
    const provided = await config.word_timing_provider({
      audioPath,
      script: normalizedScript,
      durationSeconds: measuredDuration,
    });
    if (Array.isArray(provided)) {
      returnedTimings = provided;
      timingSource = "whisper-cli";
    } else {
      returnedTimings = provided.words;
      timingSource = provided.source;
    }
  } else if (returnedTimings.length === 0 && config.timing_backend === "whisper-cli") {
    try {
      const aligned = await runWhisperCliWordTimings(audioPath, {
        whisper_binary: config.whisper_binary,
        whisper_model: config.whisper_model,
      });
      returnedTimings = aligned.words;
      timingSource = aligned.source;
    } catch (error) {
      timingUnavailableReason = `word_timing_backend_failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (returnedTimings.length > 0 && (config.repair_word_timings ?? config.timing_backend === "whisper-cli")) {
    const repair = normalizeWordTimingsForScript(normalizedScript, returnedTimings, measuredDuration);
    returnedTimings = repair.words;
    if (repair.estimated) {
      timingSource = "estimated";
    }
  }

  const wordsPayload: WordsFile = {
    job_id: options.jobId ?? "",
    segment_id: segmentId,
    timing:
      returnedTimings.length > 0
        ? { status: "available", source: timingSource }
        : {
            status: "unavailable",
            source: timingSource,
            reason: timingUnavailableReason,
          },
    words: returnedTimings,
  };
  await writeFile(wordsPath, JSON.stringify(wordsPayload, null, 2), "utf8");

  return {
    id: segmentId,
    title: segment.title,
    script: normalizedScript,
    audio_path: audioPath,
    duration_seconds: measuredDuration,
    words_path: wordsPath,
    status: "rendered",
    provenance: {
      profile_id: config.profile_id || options.voiceProfile || "unknown",
      profile_version: config.profile_version || "unknown",
      reference_clip_sha: await getReferenceClipSha(config, referenceClip),
      model: config.model || "unknown",
      narrationlayer_commit: getNarrationLayerCommit(config),
    },
  };
}

export function getQwen3ReferencePath(config: VoiceLayerQwen3Config, baseDir: string): string | undefined {
  if (config.reference_clip) {
    return path.resolve(baseDir, config.reference_clip);
  }
  if (config.reference_text_path) {
    return path.resolve(baseDir, config.reference_text_path);
  }
  if (Array.isArray(config.reference_clips) && config.reference_clips.length > 0) {
    return path.resolve(baseDir, config.reference_clips[0]);
  }
  return undefined;
}

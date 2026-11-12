import { synthesizeQwen3, Qwen3DaemonError, type Qwen3Synthesis } from "../../backends/qwen3-daemon.js";
import { probeAudioDurationSeconds } from "../../audio.js";
import type { VoiceLayerQwen3Config } from "../../core/render-types.js";
import type { RenderSegmentOptions } from "../../renderers/types.js";
import { getWordsFromScript } from "../../timing/script-words.js";
import { coerceNumber } from "../../timing/returned-timings.js";

const DEFAULT_MAX_CHUNK_DURATION_SECONDS = 45;
const DEFAULT_MAX_CHUNK_SECONDS_PER_WORD = 3;
const DEFAULT_MIN_CHUNK_DURATION_SECONDS = 30;
export const DEFAULT_MAX_CHUNK_RETRIES = 1;

export class RunawayGeneratedChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunawayGeneratedChunkError";
  }
}

export function normalizeDuration(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Number(value.toFixed(3));
}

function cleanPositive(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

export function cleanNonNegativeInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : Math.floor(value);
}

function getGeneratedChunkDurationLimitSeconds(text: string, config: VoiceLayerQwen3Config): number {
  const wordCount = Math.max(1, getWordsFromScript(text).length);
  const absoluteLimit = cleanPositive(config.max_chunk_duration_seconds, DEFAULT_MAX_CHUNK_DURATION_SECONDS);
  const secondsPerWord = cleanPositive(config.max_chunk_seconds_per_word, DEFAULT_MAX_CHUNK_SECONDS_PER_WORD);
  return Number(Math.min(absoluteLimit, Math.max(DEFAULT_MIN_CHUNK_DURATION_SECONDS, wordCount * secondsPerWord)).toFixed(3));
}

async function getGeneratedChunkDurationSeconds(args: {
  payload: Qwen3Synthesis;
  audioPath: string;
  config: VoiceLayerQwen3Config;
}): Promise<number | undefined> {
  return (
    normalizeDuration(await (args.config.audio_duration_probe ?? probeAudioDurationSeconds)(args.audioPath)) ??
    getPayloadDurationSeconds(args.payload)
  );
}

export async function assertGeneratedChunkDuration(args: {
  segmentId: string;
  chunkIndex: number;
  text: string;
  payload: Qwen3Synthesis;
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

export async function synthesizeText(args: {
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
}): Promise<Qwen3Synthesis> {
  let payload: Qwen3Synthesis;
  try {
    payload = await synthesizeQwen3({
      url: `${args.daemonUrl}/synthesize`,
      authToken: args.authToken,
      body: {
        text: args.text,
        reference_wav: args.referenceClip,
        reference_text: args.referenceText,
        ...(args.model ? { model: args.model } : {}),
        ...(args.loraAdapterPath ? { lora_adapter_path: args.loraAdapterPath } : {}),
        ...(args.loraScale === undefined ? {} : { lora_scale: args.loraScale }),
      },
      timeoutMs: args.timeoutMs,
      fetchImpl: args.fetchImpl,
    });
  } catch (error) {
    if (!(error instanceof Qwen3DaemonError)) throw error;
    const failure = error.failure;
    if (failure.kind === "http") {
      throw new Error(`voicelayer-qwen3 synthesize failed (${failure.status}): ${failure.body || failure.statusText}`);
    }
    if (failure.kind === "missing-audio") throw new Error("voicelayer-qwen3 response missing audio_b64");
    throw failure.cause;
  }
  if (args.loraAdapterPath && payload.loraApplied !== true) {
    throw new Error("voicelayer-qwen3 daemon did not confirm LoRA adapter application");
  }
  return payload;
}

export function getPayloadDurationSeconds(payload: Qwen3Synthesis): number | undefined {
  const payloadDurationMs = coerceNumber(payload.audioDurationMs) ?? coerceNumber(payload.elapsedGenerationMs);
  return payloadDurationMs === undefined ? undefined : normalizeDuration(payloadDurationMs / 1000);
}

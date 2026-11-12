import type { Qwen3Synthesis } from "../../backends/qwen3-daemon.js";
import type { AudioAssemblyChunk, VoiceLayerQwen3Config } from "../../core/render-types.js";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { resolveWithinRoot } from "../../path-safety.js";
import { assembleAudioWithSilence, trimAudioSilence, applyAudioEq, probeAudioDurationSeconds } from "../../audio.js";
import { utterancesV1, toPlannedUtterances } from "../../plan/index.js";
import type { RenderManifestSegment, TimingSource, WordsFile } from "../../schema.js";
import { deriveSpeechAliases, normalizeForSpeech } from "../../text-normalize.js";
import type { RenderSegmentOptions } from "../../renderers/types.js";
import { runWhisperCliWordTimings } from "../../word-timings.js";
import { normalizeWordTimingsForScript } from "../../word-timing-repair.js";
import { normalizeReturnedTimings } from "../../timing/returned-timings.js";
import { expandHome, loadAuthToken, loadReferenceText, getReferenceClip } from "./config.js";
import { getNarrationLayerCommit, getReferenceClipSha } from "../job-render-provenance.js";
import { assertGeneratedChunkDuration, cleanNonNegativeInteger, DEFAULT_MAX_CHUNK_RETRIES, getPayloadDurationSeconds, normalizeDuration, RunawayGeneratedChunkError, synthesizeText } from "./synthesis.js";

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
  const artifactsRoot = resolveWithinRoot(options.artifactsDir, "segments", segmentId);
  const audioPath = resolveWithinRoot(artifactsRoot, `${segmentId}.mp3`);
  const wordsPath = resolveWithinRoot(artifactsRoot, "words.json");
  await mkdir(artifactsRoot, { recursive: true });
  const plannedUtterances = toPlannedUtterances(utterancesV1(normalizedScript, config));
  const shouldTrim = config.trim_silence === true;
  const chunksRoot = resolveWithinRoot(artifactsRoot, "chunks");
  const shouldAssemble = plannedUtterances.length > 1 || plannedUtterances.some((item) => item.pause_after_seconds > 0);
  if (shouldAssemble || shouldTrim) {
    await mkdir(chunksRoot, { recursive: true });
  }

  const audioChunks: AudioAssemblyChunk[] = [];
  let lastPayload: Qwen3Synthesis | undefined;
  let fallbackDurationSeconds = 0;
  const maxChunkRetries = cleanNonNegativeInteger(config.max_chunk_retries, DEFAULT_MAX_CHUNK_RETRIES);
  for (let index = 0; index < plannedUtterances.length; index += 1) {
    const utterance = plannedUtterances[index];
    let acceptedPayload: Qwen3Synthesis | undefined;
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
        ? resolveWithinRoot(chunksRoot, `${suffix}.raw.mp3`)
        : shouldAssemble
          ? resolveWithinRoot(chunksRoot, `${suffix}.mp3`)
          : audioPath;
      await writeFile(rawChunkPath, Buffer.from(payload.audioBase64, "base64"));
      const chunkPath = shouldTrim
        ? shouldAssemble
          ? resolveWithinRoot(chunksRoot, `${suffix}.mp3`)
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
        const eqPath = resolveWithinRoot(artifactsRoot, `${chunkPath}.eq.mp3`);
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

  // Persist the accepted utterances: these are the exact strings sent to TTS.
  const spokenPath = `${audioPath}.spoken.txt`;
  await writeFile(spokenPath, plannedUtterances.map(utterance => utterance.text).join(" "), "utf8");

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
  const spokenText = await readFile(spokenPath, "utf8");
  if (returnedTimings.length > 0 && (segment.script !== spokenText || (config.repair_word_timings ?? config.timing_backend === "whisper-cli"))) {
    const repair = normalizeWordTimingsForScript(segment.script, returnedTimings, measuredDuration, deriveSpeechAliases(segment.script, spokenText));
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
    script: segment.script,
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

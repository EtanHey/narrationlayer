import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  fileExists,
  getAllJobIds,
  getDataDir,
  getJob,
  getManifest,
  getStatus,
  initializeJob,
  markDone,
  markFailed,
  pathsForJob,
  writeManifest,
  writeStatus,
} from "./job-store.js";
import { renderSegment as renderExternalSegment, type ExternalCommandConfig } from "./renderers/external-command.js";
import { renderSegment as renderFakeSegment } from "./renderers/fake.js";
import { renderSegment as renderQwenSegment, type VoiceLayerQwen3Config } from "./renderers/voicelayer-qwen3.js";
import {
  externalCommandConfigFromProfile,
  findProfile,
  getProfileSummary,
  qwenConfigFromProfile,
  warnIfNonAcceptedProfile,
} from "./profiles.js";
import {
  parseNarrationJob,
  type JobStatus,
  type NarrationJobInput,
  type RenderManifest,
  type RenderManifestSegment,
} from "./schema.js";

export interface CreatedJobResult {
  job_id: string;
  job_path: string;
  status_path: string;
  manifest_path: string;
}

export interface StatusSummary {
  status: JobStatus;
  done: boolean;
  failed: boolean;
  manifest_exists: boolean;
  manifest: RenderManifest | null;
}

export interface RenderJobResult {
  status: JobStatus;
  manifest: RenderManifest;
}

export interface RendererRuntimeConfig {
  qwen: VoiceLayerQwen3Config;
  external: ExternalCommandConfig;
}

function numberFromEnv(name: string, fallback: number | undefined): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function anyNumberFromEnv(name: string, fallback: number | undefined): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanFromEnv(name: string, fallback: boolean | undefined): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return fallback;
}

export function getRendererConfigFromEnv(
  overrides: Partial<VoiceLayerQwen3Config> = {},
  externalOverrides: Partial<ExternalCommandConfig> = {},
): RendererRuntimeConfig {
  const referenceClip = process.env.NARRATIONLAYER_QWEN3_REFERENCE_CLIP;
  const referenceText = process.env.NARRATIONLAYER_QWEN3_REFERENCE_TEXT;
  const referenceTextPath = process.env.NARRATIONLAYER_QWEN3_REFERENCE_TEXT_PATH;
  const referenceClips = process.env.NARRATIONLAYER_QWEN3_REFERENCE_CLIPS;
  const referenceClipList = referenceClips ? referenceClips.split(",").map((item) => item.trim()).filter(Boolean) : [];
  return {
    qwen: {
      profile_id: overrides.profile_id,
      profile_version: overrides.profile_version,
      reference_clip_sha: overrides.reference_clip_sha,
      model: overrides.model,
      narrationlayer_commit: overrides.narrationlayer_commit,
      daemon_url: process.env.NARRATIONLAYER_QWEN3_DAEMON_URL ?? overrides.daemon_url,
      timeout_ms: numberFromEnv("NARRATIONLAYER_QWEN3_TIMEOUT_MS", overrides.timeout_ms),
      auth_token: process.env.NARRATIONLAYER_QWEN3_AUTH_TOKEN ?? overrides.auth_token,
      auth_token_file: process.env.NARRATIONLAYER_QWEN3_AUTH_TOKEN_FILE ?? overrides.auth_token_file,
      reference_clip: referenceClip ?? overrides.reference_clip,
      reference_text: referenceText ?? overrides.reference_text,
      reference_text_path: referenceTextPath ?? overrides.reference_text_path,
      reference_clips: referenceClipList.length ? referenceClipList : overrides.reference_clips,
      lora_adapter_path: overrides.lora_adapter_path,
      lora_scale: overrides.lora_scale,
      timing_backend: overrides.timing_backend,
      pause_strategy:
        process.env.NARRATIONLAYER_QWEN3_PAUSE_STRATEGY === "punctuation" ||
        process.env.NARRATIONLAYER_QWEN3_PAUSE_STRATEGY === "none"
          ? process.env.NARRATIONLAYER_QWEN3_PAUSE_STRATEGY
          : overrides.pause_strategy,
      max_utterance_words: numberFromEnv("NARRATIONLAYER_QWEN3_MAX_UTTERANCE_WORDS", overrides.max_utterance_words),
      min_utterance_words: numberFromEnv("NARRATIONLAYER_QWEN3_MIN_UTTERANCE_WORDS", overrides.min_utterance_words),
      sentence_pause_seconds: numberFromEnv(
        "NARRATIONLAYER_QWEN3_SENTENCE_PAUSE_SECONDS",
        overrides.sentence_pause_seconds,
      ),
      comma_pause_seconds: numberFromEnv("NARRATIONLAYER_QWEN3_COMMA_PAUSE_SECONDS", overrides.comma_pause_seconds),
      trim_silence: booleanFromEnv("NARRATIONLAYER_QWEN3_TRIM_SILENCE", overrides.trim_silence),
      silence_threshold_db: anyNumberFromEnv("NARRATIONLAYER_QWEN3_SILENCE_THRESHOLD_DB", overrides.silence_threshold_db),
      eq_highshelf_hz: overrides.eq_highshelf_hz,
      eq_highshelf_gain_db: overrides.eq_highshelf_gain_db,
      loudness_target_db: overrides.loudness_target_db,
      atempo: overrides.atempo,
      silence_padding_seconds: numberFromEnv(
        "NARRATIONLAYER_QWEN3_SILENCE_PADDING_SECONDS",
        overrides.silence_padding_seconds,
      ),
      repair_word_timings: booleanFromEnv("NARRATIONLAYER_QWEN3_REPAIR_WORD_TIMINGS", overrides.repair_word_timings),
      max_chunk_duration_seconds: numberFromEnv(
        "NARRATIONLAYER_QWEN3_MAX_CHUNK_DURATION_SECONDS",
        overrides.max_chunk_duration_seconds,
      ),
      max_chunk_seconds_per_word: numberFromEnv(
        "NARRATIONLAYER_QWEN3_MAX_CHUNK_SECONDS_PER_WORD",
        overrides.max_chunk_seconds_per_word,
      ),
      max_chunk_retries: numberFromEnv("NARRATIONLAYER_QWEN3_MAX_CHUNK_RETRIES", overrides.max_chunk_retries),
      whisper_binary: overrides.whisper_binary,
      whisper_model: overrides.whisper_model,
    },
    external: {
      ...externalOverrides,
    },
  };
}

export async function getRendererConfigForVoiceProfile(voiceProfile: string): Promise<RendererRuntimeConfig> {
  const profile = await findProfile(voiceProfile);
  warnIfNonAcceptedProfile(profile, voiceProfile);
  return getRendererConfigFromEnv(qwenConfigFromProfile(profile), externalCommandConfigFromProfile(profile));
}

function payloadHasRenderer(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) && "renderer" in payload;
}

export async function createJobFromPayload(payload: unknown, dataDir = getDataDir()): Promise<CreatedJobResult> {
  const job = parseNarrationJob(payload);
  const profile = await findProfile(job.voice_profile);
  warnIfNonAcceptedProfile(profile, job.voice_profile);
  if (!payloadHasRenderer(payload)) {
    if (profile?.renderer) {
      job.renderer = profile.renderer;
    }
  }
  if (profile?.id && profile.id !== job.voice_profile) {
    job.voice_profile = profile.id;
  }
  const { job: savedJob, paths } = await initializeJob(job, dataDir);
  return {
    job_id: savedJob.job_id,
    job_path: paths.jobPath,
    status_path: paths.statusPath,
    manifest_path: paths.manifestPath,
  };
}

export async function createJobFromFile(jobFilePath: string, dataDir = getDataDir()): Promise<CreatedJobResult> {
  const payloadRaw = await readFile(jobFilePath, "utf8");
  return createJobFromPayload(JSON.parse(payloadRaw) as NarrationJobInput, dataDir);
}

export async function getStatusSummary(jobId: string, dataDir = getDataDir()): Promise<StatusSummary> {
  const status = await getStatus(jobId, dataDir);
  if (!status) {
    throw new Error(`Status not found for job: ${jobId}`);
  }
  const paths = pathsForJob(jobId, dataDir);
  const manifest = await getManifest(jobId, dataDir);
  return {
    status,
    done: await fileExists(paths.donePath),
    failed: await fileExists(paths.failedPath),
    manifest_exists: Boolean(manifest),
    manifest,
  };
}

export async function getJobResult(jobId: string, dataDir = getDataDir()) {
  const job = await getJob(jobId, dataDir);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  const manifest = await getManifest(jobId, dataDir);
  if (!manifest) {
    throw new Error(`Manifest not found for job: ${jobId}`);
  }
  return { job, manifest };
}

export async function listJobIds(dataDir = getDataDir()): Promise<string[]> {
  return getAllJobIds(dataDir);
}

export async function getDoctorSummary() {
  const dataDir = getDataDir();
  return {
    service: "NarrationLayer",
    version: "v1",
    data_dir: dataDir,
    jobs_dir: path.join(dataDir, "jobs"),
    default_renderer: process.env.NARRATIONLAYER_DEFAULT_RENDERER || "fake",
    profiles: await getProfileSummary(),
  };
}

export async function renderJob(
  jobId: string,
  dataDir = getDataDir(),
  config?: RendererRuntimeConfig,
): Promise<RenderJobResult> {
  const job = await getJob(jobId, dataDir);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const paths = pathsForJob(jobId, dataDir);
  const renderConfig = config ?? (await getRendererConfigForVoiceProfile(job.voice_profile));
  const startedAt = new Date().toISOString();
  const manifest: RenderManifest = {
    job_id: job.job_id,
    created_at: startedAt,
    voice_profile: job.voice_profile,
    renderer: job.renderer,
    segments: [],
    total_duration_seconds: 0,
    artifacts_dir: path.join(paths.jobDir, "artifacts"),
    errors: [],
  };

  let status: JobStatus = {
    job_id: job.job_id,
    status: "rendering",
    created_at: job.created_at,
    updated_at: new Date().toISOString(),
    progress: { completed_segments: 0, total_segments: job.segments.length },
    errors: [],
  };
  await writeStatus(jobId, status, dataDir);

  for (let index = 0; index < job.segments.length; index += 1) {
    const segment = job.segments[index];
    status = {
      ...status,
      current_step: `rendering segment ${segment.id}`,
      progress: {
        completed_segments: index,
        total_segments: job.segments.length,
      },
      updated_at: new Date().toISOString(),
    };
    await writeStatus(jobId, status, dataDir);

    try {
      let result: RenderManifestSegment;
      if (job.renderer === "fake") {
        result = await renderFakeSegment(segment.id, segment, job, {
          artifactsDir: manifest.artifacts_dir,
          dataDir,
        });
      } else if (job.renderer === "voicelayer-qwen3") {
        result = await renderQwenSegment(
          segment.id,
          segment,
          {
            artifactsDir: manifest.artifacts_dir,
            dataDir,
            jobId: job.job_id,
            voiceProfile: job.voice_profile,
          },
          renderConfig.qwen,
        );
      } else {
        result = await renderExternalSegment(
          segment.id,
          segment,
          {
            artifactsDir: manifest.artifacts_dir,
            dataDir,
            jobId: job.job_id,
            voiceProfile: job.voice_profile,
          },
          renderConfig.external,
        );
      }

      manifest.segments.push(result);
      manifest.total_duration_seconds = Number((manifest.total_duration_seconds + result.duration_seconds).toFixed(3));
      status = {
        ...status,
        progress: {
          completed_segments: index + 1,
          total_segments: job.segments.length,
        },
        updated_at: new Date().toISOString(),
      };
      await writeManifest(jobId, manifest, dataDir);
      await writeStatus(jobId, status, dataDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const segmentError = `Segment ${segment.id}: ${message}`;
      manifest.errors.push(segmentError);
      manifest.segments.push({
        id: segment.id,
        title: segment.title,
        script: segment.script,
        audio_path: "",
        duration_seconds: segment.duration_seconds ?? 0,
        words_path: "",
        status: "failed",
        error: segmentError,
      });
      status = {
        ...status,
        status: "failed",
        progress: {
          completed_segments: index + 1,
          total_segments: job.segments.length,
        },
        updated_at: new Date().toISOString(),
        errors: [...status.errors, segmentError],
      };
      await writeManifest(jobId, manifest, dataDir);
      await writeStatus(jobId, status, dataDir);
      await markFailed(jobId, dataDir);
      throw error;
    }
  }

  const finished: JobStatus = {
    ...status,
    status: "done",
    updated_at: new Date().toISOString(),
    progress: {
      completed_segments: job.segments.length,
      total_segments: job.segments.length,
    },
    current_step: "complete",
    errors: manifest.errors,
  };
  await writeManifest(jobId, manifest, dataDir);
  await writeStatus(jobId, finished, dataDir);
  await markDone(jobId, dataDir);
  return { status: finished, manifest };
}

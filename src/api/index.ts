// NarrationLayer's public surface: the package's "." export. Re-exports only; nothing inside the repo imports this file.
// A name is here because it was meant for outside callers, or because a public declaration names it. No per-name
// inventory of outside callers exists, so which names an outside consumer really uses is not recorded (docs/architecture.md).
// Changing this surface needs `bun scripts/dev/snapshot-surface.ts --update` and a reason in the PR (docs/architecture.md).

// Jobs: create, render and read narration jobs (what the CLI and the MCP server call).
export {
  createJobFromFile,
  createJobFromPayload,
  getDoctorSummary,
  getJobResult,
  getStatusSummary,
  listJobIds,
  renderJob,
  type CreatedJobResult,
  type RenderJobResult,
  type RendererRuntimeConfig,
  type StatusSummary,
} from "../service.js";
export type {
  JobStatus,
  NarrationJobInput,
  NarrationSegmentInput,
  NormalizedNarrationJob,
  NormalizedNarrationSegment,
  RenderManifest,
  RenderManifestSegment,
  RendererName,
  SegmentStatus,
  TimingSource,
  TimingStatus,
  WordsFile,
  WordsTimingMetadata,
  WordTiming,
} from "../schema.js";
export type { AudioAssemblyChunk, ExternalCommandConfig, NarrationPacingConfig, PauseStrategy, VoiceLayerQwen3Config, WordTimingResult } from "../core/render-types.js";
export type { ProfileSummary } from "../profiles.js";

// Text: the spoken form of display text.
export { deriveSpeechAliases, normalizeForSpeech, normalizeLegacy, prepareSpeechChannels, type SpeechChannels, type TermRule } from "../text-normalize.js";

// Planning: the one piece type and its two policies.
export { breathingV1, utterancesV1, type Piece } from "../plan/index.js";

// Word timing: whisper-cli timings and their repair against the script.
export { runWhisperCliWordTimings, type WhisperTimingOptions } from "../word-timings.js";
export { normalizeWordTimingsForScript, type WordTimingAlias, type WordTimingRepairResult } from "../word-timing-repair.js";

// Local TTS: the runner's argv entry, with an injectable speech preparation, and its take cache.
export { main as runLocalTtsCli, type SpeechPreparation } from "../../bin/local-tts-runner.js";
export { clearTakeCacheReceipt, computeContentHashKey, writeTakeCacheReceipt, type CacheKeyParams } from "../pipelines/local-tts/take-cache.js";

// Teleprompter: markup and runtime script for a narrated page.
export { renderTeleprompterMarkup, teleprompterRuntimeScript, type TeleprompterPayload, type TeleprompterSegment } from "../teleprompter.js";

import type { AudioAssemblyChunk } from "./audio.js";
import type { NarrationPacingConfig } from "./narration-plan.js";
import type { WordTiming } from "./schema.js";
import type { WordTimingResult } from "./word-timings.js";

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

export interface ExternalCommandConfig {
  command?: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
  output_ext?: string;
  reference_clip?: string;
  reference_text?: string;
  reference_text_path?: string;
  timing_backend?: "estimated" | "none";
  audio_duration_probe?: (audioPath: string) => Promise<number | undefined>;
}


export type RendererName = "fake" | "voicelayer-qwen3" | "external-command";
export type SegmentStatus = "pending" | "rendered" | "failed" | "skipped";
export type TimingSource = RendererName | "whisper-cli" | "estimated";

export interface NarrationSegmentInput {
  id?: string;
  title: string;
  script: string;
  duration_seconds?: number;
  notes?: string;
}

export interface NarrationJobInput {
  job_id?: string;
  created_at?: string;
  voice_profile: string;
  renderer?: RendererName;
  segments: NarrationSegmentInput[];
}

export interface NormalizedNarrationSegment extends NarrationSegmentInput {
  id: string;
  title: string;
  script: string;
  duration_seconds?: number;
}

export interface NormalizedNarrationJob extends Omit<
  NarrationJobInput,
  "segments"
> {
  job_id: string;
  created_at: string;
  voice_profile: string;
  renderer: RendererName;
  segments: NormalizedNarrationSegment[];
}

export interface RenderManifestSegment {
  id: string;
  title: string;
  script: string;
  audio_path: string;
  duration_seconds: number;
  words_path: string;
  status: SegmentStatus;
  error?: string;
}

export interface RenderManifest {
  job_id: string;
  created_at: string;
  voice_profile: string;
  renderer: RendererName;
  segments: RenderManifestSegment[];
  total_duration_seconds: number;
  artifacts_dir: string;
  errors: string[];
}

export interface JobStatus {
  job_id: string;
  status: "queued" | "rendering" | "done" | "failed";
  updated_at: string;
  created_at: string;
  progress: {
    completed_segments: number;
    total_segments: number;
  };
  current_step?: string;
  errors: string[];
}

export type TimingStatus = "available" | "unavailable";

export interface WordTiming {
  index: number;
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface WordsTimingMetadata {
  status: TimingStatus;
  source: TimingSource;
  reason?: string;
}

/**
 * Per-word display-highlight timings for a rendered segment.
 *
 * Upstream producer note: durable `WordsFile` payloads should come from a
 * post-generation forced-aligner pass after audio is written. Naive timings
 * extrapolated from TTS duration are a known-bad source for real narration
 * alignment and should stay limited to explicit fallback/demo paths. See
 * voice-agent-dashboard findings F4 / C-ADD-1 (DR §5).
 */
export interface WordsFile {
  job_id: string;
  segment_id: string;
  timing: WordsTimingMetadata;
  words: WordTiming[];
}

export interface McpCreateJobArgs {
  job: unknown;
}

export interface McpGetArgs {
  job_id: string;
}

function isString(value: unknown, minLen = 1): value is string {
  return typeof value === "string" && value.trim().length >= minLen;
}

function normalizeRenderer(value: unknown): RendererName {
  if (value === "voicelayer-qwen3") {
    return value;
  }
  if (value === "external-command") {
    return value;
  }
  return "fake";
}

export function parseNarrationJob(raw: unknown): NormalizedNarrationJob {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Job payload must be an object");
  }

  const input = raw as Record<string, unknown>;
  const voiceProfile = isString(input.voice_profile)
    ? input.voice_profile.trim()
    : "";
  if (!voiceProfile) {
    throw new Error("voice_profile must be a non-empty string");
  }

  const segmentsRaw = input.segments;
  if (!Array.isArray(segmentsRaw) || segmentsRaw.length < 1) {
    throw new Error("segments must be a non-empty array");
  }

  const segments: NormalizedNarrationSegment[] = segmentsRaw.map(
    (segment, index) => {
      if (
        typeof segment !== "object" ||
        segment === null ||
        Array.isArray(segment)
      ) {
        throw new Error(`segments[${index}] must be an object`);
      }
      const data = segment as Record<string, unknown>;
      const title = isString(data.title) ? data.title.trim() : "";
      const script = isString(data.script) ? data.script.trim() : "";
      if (!title || !script) {
        throw new Error(`segments[${index}] requires title and script`);
      }
      const id = isString(data.id) ? data.id.trim() : `segment-${index + 1}`;
      const durationRaw = data.duration_seconds;
      const duration =
        typeof durationRaw === "number" &&
        Number.isFinite(durationRaw) &&
        durationRaw > 0
          ? durationRaw
          : undefined;
      return {
        id,
        title,
        script,
        duration_seconds: duration,
      };
    },
  );

  return {
    job_id: isString(input.job_id) ? input.job_id.trim() : randomUUID(),
    created_at: isString(input.created_at)
      ? input.created_at
      : new Date().toISOString(),
    voice_profile: voiceProfile,
    renderer: normalizeRenderer(input.renderer),
    segments,
  };
}
import { randomUUID } from "node:crypto";

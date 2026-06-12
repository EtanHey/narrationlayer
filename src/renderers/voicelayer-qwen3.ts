import path from "node:path";

export interface RenderSegmentOptions {
  artifactsDir: string;
  dataDir: string;
  logger?: (...args: unknown[]) => void;
}

export interface VoiceLayerQwen3Config {
  reference_clip?: string;
  reference_text_path?: string;
  reference_clips?: string[];
}

export function getWordsFromScript(script: string): string[] {
  return script
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export async function renderSegment(
  segmentId: string,
  segment: { title: string; script: string; duration_seconds?: number },
  dataDir: string,
  config: VoiceLayerQwen3Config,
): Promise<never> {
  throw new Error(
    `voicelayer-qwen3 is not active in v0. Configure this adapter with a real service token, then replace this stub.
Reference notes:
 - Some environments use mlx_audio.tts.load(...), not top-level aliases.
 - Qwen3 streaming often emits generator chunks, not a single bytes object.
 - Some profiles use reference_clip + reference_text_path, while others are migrating to reference_clips[].
Current segment: ${segmentId}`,
  );
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

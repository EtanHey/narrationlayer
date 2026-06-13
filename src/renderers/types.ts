import type { NormalizedNarrationJob, NormalizedNarrationSegment, RenderManifestSegment } from "../schema.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RenderSegmentOptions {
  artifactsDir: string;
  dataDir: string;
  jobId?: string;
  voiceProfile?: string;
  fetch?: FetchLike;
  logger?: (...args: unknown[]) => void;
}

export interface SegmentRenderer<TConfig = unknown> {
  renderSegment(
    segmentId: string,
    segment: NormalizedNarrationSegment,
    job: NormalizedNarrationJob,
    options: RenderSegmentOptions,
    config?: TConfig,
  ): Promise<RenderManifestSegment>;
}

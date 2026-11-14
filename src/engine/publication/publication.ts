import { createHash } from "node:crypto";
import type { Message } from "../messages/messages";
import { decodePcm, firstAudibleOffsetMs } from "./decoded";
import { startMs, wordTimes, type Samples } from "./time";
type Plan = Message<"plan">;
export type PublicationContext = Pick<Plan, "session_id" | "attempt_id" | "owner_epoch" | "engine"> & {
  index: number; piece_id: string; prefix: readonly Samples[]; synthesis_ms: number; spoken_text: string;
  words: Plan["words"]; segments: number; rate: string;
};
export type PublishedPiece = Omit<Message<"piece_ready">, "protocol" | "owner_epoch" | "seq"> & {
  known_ms: number; first_audible_offset_ms: number;
};
export interface ArtifactPort {
  put(bytes: Uint8Array, identity: Pick<PublicationContext, "owner_epoch" | "session_id" | "attempt_id" | "piece_id">, signal: AbortSignal): Promise<{ handle: string; lease_id: string; format: "wav" }>;
  release(lease_id: string): { kind: "released" | "expired" | "failed" };
  commit(identity: Pick<PublicationContext, "owner_epoch" | "session_id" | "attempt_id">, signal: AbortSignal): Promise<void>;
}
/** Layer 3 composes the independent layer-2 audio and timing leaves; no session or conformance imports. */
export function createPublication(artifacts: ArtifactPort) {
  return {
    async piece(audio: { bytes: Uint8Array; timings: unknown }, context: PublicationContext, signal: AbortSignal): Promise<PublishedPiece> {
      signal.throwIfAborted();
      const bytes = audio.bytes.slice(), decoded = decodePcm(bytes);
      const duration_ms = startMs([decoded]), start_ms = startMs(context.prefix);
      const known_ms = startMs([...context.prefix, decoded]), first_audible_offset_ms = firstAudibleOffsetMs(bytes);
      const words = wordTimes(context.words, start_ms, duration_ms, audio.timings);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const stored = await artifacts.put(bytes, { owner_epoch: context.owner_epoch, session_id: context.session_id, attempt_id: context.attempt_id, piece_id: context.piece_id }, signal);
      try {
        signal.throwIfAborted();
        return { type: "piece_ready", session_id: context.session_id, attempt_id: context.attempt_id, index: context.index, piece_id: context.piece_id,
          start_ms, duration_ms, known_ms, first_audible_offset_ms, spoken_text: context.spoken_text, synthesis_ms: Math.round(context.synthesis_ms),
          artifact: { ...stored, sample_count: decoded.sample_count, sample_rate: decoded.sample_rate, sha256 }, words,
          actual: Array.from({ length: context.segments }, (_, segment) => ({ segment, engine: context.engine.family, voice: context.engine.voice, substituted: false })),
          synthesis: { rate: context.rate, attempts: [], unavailable: [], fallback_reason: null } };
      } catch (error) { artifacts.release(stored.lease_id); throw error; }
    },
    release: artifacts.release.bind(artifacts),
    commit: artifacts.commit.bind(artifacts),
  };
}

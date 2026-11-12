import type { WordTiming } from "../schema.js";

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

interface ReturnedTimingPayload {
  word_timings: unknown;
  words: unknown;
  word_boundaries: unknown;
}

export function coerceNumber(value: unknown): number | undefined {
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

export function normalizeReturnedTimings(payload: ReturnedTimingPayload): WordTiming[] {
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

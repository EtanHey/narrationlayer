import type { WordTiming } from "./schema.js";

export interface WordTimingRepairResult {
  words: WordTiming[];
  repaired: boolean;
  reason?: "word_mismatch" | "suspicious_timing";
}

function scriptWords(script: string): string[] {
  return String(script || "")
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\w]+|[^\w.?!,;:]+$/g, ""))
    .filter(Boolean);
}

function comparable(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function estimateWords(words: string[], durationSeconds: number): WordTiming[] {
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : words.length / 2.5;
  const unit = duration / Math.max(words.length, 1);
  return words.map((word, index) => ({
    index,
    word,
    start: Number((unit * index).toFixed(3)),
    end: Number((index === words.length - 1 ? duration : unit * (index + 1)).toFixed(3)),
  }));
}

function wordsMatchScript(scriptTokens: string[], timings: WordTiming[]): boolean {
  if (scriptTokens.length !== timings.length) {
    return false;
  }
  return scriptTokens.every((word, index) => comparable(word) === comparable(timings[index].word));
}

function hasSuspiciousTiming(timings: WordTiming[], durationSeconds: number): boolean {
  if (!timings.length) {
    return true;
  }
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : timings.at(-1)?.end ?? 0;
  const maxReasonableWordDuration = Math.max(0.9, safeDuration / Math.max(timings.length, 1) * 2.4);
  for (let index = 0; index < timings.length; index += 1) {
    const timing = timings[index];
    const wordDuration = timing.end - timing.start;
    if (wordDuration < 0.05 || wordDuration > maxReasonableWordDuration) {
      return true;
    }
    if (index > 0 && timing.start < timings[index - 1].end - 0.01) {
      return true;
    }
  }
  const last = timings[timings.length - 1];
  return safeDuration > 0 && last.end < safeDuration * 0.85;
}

export function normalizeWordTimingsForScript(
  script: string,
  timings: WordTiming[],
  durationSeconds: number,
): WordTimingRepairResult {
  const expectedWords = scriptWords(script);
  if (!expectedWords.length) {
    return { words: timings, repaired: false };
  }

  if (!wordsMatchScript(expectedWords, timings)) {
    return {
      words: estimateWords(expectedWords, durationSeconds),
      repaired: true,
      reason: "word_mismatch",
    };
  }

  if (hasSuspiciousTiming(timings, durationSeconds)) {
    return {
      words: estimateWords(expectedWords, durationSeconds),
      repaired: true,
      reason: "suspicious_timing",
    };
  }

  return {
    words: timings.map((timing, index) => ({ ...timing, index })),
    repaired: false,
  };
}

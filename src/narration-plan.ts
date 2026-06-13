export type PauseStrategy = "none" | "punctuation";

export interface NarrationPacingConfig {
  pause_strategy?: PauseStrategy;
  max_utterance_words?: number;
  min_utterance_words?: number;
  sentence_pause_seconds?: number;
  comma_pause_seconds?: number;
}

export interface PlannedUtterance {
  text: string;
  pause_after_seconds: number;
}

const DEFAULT_MAX_UTTERANCE_WORDS = 14;
const DEFAULT_MIN_UTTERANCE_WORDS = 3;
const DEFAULT_SENTENCE_PAUSE_SECONDS = 0.55;
const DEFAULT_COMMA_PAUSE_SECONDS = 0.25;

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function cleanPositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function cleanWordLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_UTTERANCE_WORDS;
}

function cleanMinimumWordLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MIN_UTTERANCE_WORDS;
}

function wordCount(value: string): number {
  return cleanText(value).split(/\s+/).filter(Boolean).length;
}

function splitSentences(script: string): string[] {
  const sentences: string[] = [];
  for (const rawLine of script.replace(/\r\n/g, "\n").split(/\n+/)) {
    const line = cleanText(rawLine);
    if (!line) {
      continue;
    }
    const matches = line.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g);
    if (!matches) {
      sentences.push(line);
      continue;
    }
    for (const match of matches) {
      const sentence = cleanText(match);
      if (sentence) {
        sentences.push(sentence);
      }
    }
  }
  return sentences;
}

function mergeAdjacentSentences(sentences: string[], maxWords: number): string[] {
  const merged: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }
    const candidate = `${current} ${sentence}`;
    if (wordCount(candidate) <= maxWords) {
      current = candidate;
      continue;
    }
    merged.push(current);
    current = sentence;
  }
  if (current) {
    merged.push(current);
  }
  return merged;
}

function splitByWordLimit(text: string, maxWords: number, minWords: number): string[] {
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return [cleanText(text)];
  }

  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += maxWords) {
    chunks.push(words.slice(index, index + maxWords).join(" "));
  }
  const lastChunk = chunks.at(-1);
  if (chunks.length > 1 && lastChunk && wordCount(lastChunk) < minWords) {
    const previous = chunks[chunks.length - 2];
    chunks.splice(chunks.length - 2, 2, `${previous} ${lastChunk}`);
  }
  return chunks;
}

function mergeShortPhraseParts(parts: string[], minWords: number): string[] {
  const merged: string[] = [];
  for (const part of parts) {
    if (merged.length > 0 && wordCount(part) < minWords) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${part}`;
      continue;
    }
    merged.push(part);
  }

  if (merged.length > 1 && wordCount(merged[merged.length - 1]) < minWords) {
    const last = merged.pop();
    if (last) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${last}`;
    }
  }

  return merged;
}

function splitSentence(sentence: string, maxWords: number, minWords: number): string[] {
  const phraseParts = sentence.split(/(?<=[,:;])\s+/).map(cleanText).filter(Boolean);
  const parts = phraseParts.length > 1 ? mergeShortPhraseParts(phraseParts, minWords) : [sentence];
  return parts.flatMap((part) => splitByWordLimit(part, maxWords, minWords));
}

function pauseForUtterance(text: string, config: Required<NarrationPacingConfig>): number {
  if (/[,;:]\s*$/.test(text)) {
    return config.comma_pause_seconds;
  }
  if (/[.!?]["')\]]*\s*$/.test(text)) {
    return config.sentence_pause_seconds;
  }
  return config.comma_pause_seconds;
}

export function planNarrationUtterances(script: string, config: NarrationPacingConfig = {}): PlannedUtterance[] {
  const text = cleanText(script);
  if (!text) {
    return [];
  }

  if (config.pause_strategy === "none") {
    return [{ text, pause_after_seconds: 0 }];
  }

  const normalizedConfig: Required<NarrationPacingConfig> = {
    pause_strategy: "punctuation",
    max_utterance_words: cleanWordLimit(config.max_utterance_words),
    min_utterance_words: cleanMinimumWordLimit(config.min_utterance_words),
    sentence_pause_seconds: cleanPositive(config.sentence_pause_seconds, DEFAULT_SENTENCE_PAUSE_SECONDS),
    comma_pause_seconds: cleanPositive(config.comma_pause_seconds, DEFAULT_COMMA_PAUSE_SECONDS),
  };

  const utterances = mergeAdjacentSentences(splitSentences(script), normalizedConfig.max_utterance_words).flatMap((sentence) =>
    splitSentence(sentence, normalizedConfig.max_utterance_words, normalizedConfig.min_utterance_words),
  );
  const planned = utterances
    .map(cleanText)
    .filter(Boolean)
    .map((utterance): PlannedUtterance => ({
      text: utterance,
      pause_after_seconds: pauseForUtterance(utterance, normalizedConfig),
    }));

  if (planned.length > 0) {
    planned[planned.length - 1].pause_after_seconds = 0;
  }

  return planned;
}

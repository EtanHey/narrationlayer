import { expect, test } from "bun:test";

import { planNarrationUtterances } from "../src/narration-plan.js";

test("punctuation pacing splits script into spoken utterances with real pause metadata", () => {
  const planned = planNarrationUtterances("First sentence. Second sentence, with a clause, and more.", {
    pause_strategy: "punctuation",
    max_utterance_words: 6,
    sentence_pause_seconds: 0.6,
    comma_pause_seconds: 0.2,
  });

  expect(planned.map((utterance) => utterance.text)).toEqual([
    "First sentence.",
    "Second sentence,",
    "with a clause, and more.",
  ]);
  expect(planned.map((utterance) => utterance.pause_after_seconds)).toEqual([0.6, 0.2, 0]);
  expect(planned.some((utterance) => /\b(breathe|pause)\b/i.test(utterance.text))).toBe(false);
});

test("punctuation pacing breaks long comma-heavy narration before it sounds breathless", () => {
  const planned = planNarrationUtterances(
    "I added ignored local voice profiles, a VoiceLayer Qwen three adapter, measured audio durations, Whisper word timings, and a dashboard teleprompter under the audio.",
    {
      pause_strategy: "punctuation",
      max_utterance_words: 7,
    },
  );

  expect(planned.length).toBeGreaterThan(1);
  expect(Math.max(...planned.map((utterance) => utterance.text.split(/\s+/).length))).toBeLessThanOrEqual(7);
  expect(Math.min(...planned.map((utterance) => utterance.text.split(/\s+/).length))).toBeGreaterThanOrEqual(3);
  expect(planned.at(-1)?.pause_after_seconds).toBe(0);
});

test("punctuation pacing does not orphan a short trailing phrase just to satisfy word limit", () => {
  const planned = planNarrationUtterances("I changed NarrationLayer so punctuation is enforced by audio.", {
    pause_strategy: "punctuation",
    max_utterance_words: 7,
  });

  expect(planned.map((utterance) => utterance.text)).toEqual([
    "I changed NarrationLayer so punctuation is enforced by audio.",
  ]);
});

test("punctuation pacing keeps adjacent short sentences together when they fit the word limit", () => {
  const planned = planNarrationUtterances(
    "I changed the pacing system again. It no longer splits short phrases like by audio into separate recordings.",
    {
      pause_strategy: "punctuation",
      max_utterance_words: 24,
      min_utterance_words: 3,
    },
  );

  expect(planned.map((utterance) => utterance.text)).toEqual([
    "I changed the pacing system again. It no longer splits short phrases like by audio into separate recordings.",
  ]);
});

test("punctuation pacing treats colon and semicolon list markers as phrase breaks", () => {
  const planned = planNarrationUtterances("The checks pass: tests, typecheck; doctor, create job, render, and status.", {
    pause_strategy: "punctuation",
    max_utterance_words: 6,
    comma_pause_seconds: 0.2,
  });

  expect(planned.map((utterance) => utterance.text)).toEqual([
    "The checks pass: tests, typecheck; doctor,",
    "create job, render, and status.",
  ]);
  expect(planned.slice(0, -1).every((utterance) => utterance.pause_after_seconds === 0.2)).toBe(true);
});

test("punctuation pacing does not isolate one-word comma fragments", () => {
  const planned = planNarrationUtterances("Each raw recording is trimmed before it is measured, aligned, or joined.", {
    pause_strategy: "punctuation",
    max_utterance_words: 14,
    min_utterance_words: 3,
  });

  expect(planned.map((utterance) => utterance.text)).toEqual([
    "Each raw recording is trimmed before it is measured, aligned, or joined.",
  ]);
});

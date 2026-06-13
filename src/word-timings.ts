import { randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { TimingSource, WordTiming } from "./schema.js";

interface WhisperToken {
  text?: unknown;
  offsets?: {
    from?: unknown;
    to?: unknown;
  };
  p?: unknown;
}

interface WhisperSegment {
  tokens?: unknown;
}

interface WhisperJson {
  transcription?: unknown;
  segments?: unknown;
}

export interface WordTimingResult {
  source: TimingSource;
  words: WordTiming[];
}

export interface WhisperTimingOptions {
  whisper_binary?: string;
  whisper_model?: string;
  language?: string;
}

async function fileExists(pathName: string): Promise<boolean> {
  try {
    await access(pathName, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

async function resolveFirstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const resolved = expandHome(candidate);
    if (await fileExists(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSpecialToken(text: string): boolean {
  return !text || /^\[_.*\]$/.test(text);
}

function isPunctuationToken(text: string): boolean {
  return /^[,.;:!?]+$/.test(text);
}

function pushCurrent(
  output: WordTiming[],
  current: { text: string; startMs: number; endMs: number; confidences: number[] } | null,
) {
  if (!current || !current.text.trim()) {
    return;
  }
  const confidence =
    current.confidences.length === 0
      ? undefined
      : Number((current.confidences.reduce((sum, item) => sum + item, 0) / current.confidences.length).toFixed(3));
  output.push({
    index: output.length,
    word: current.text.trim(),
    start: Number((current.startMs / 1000).toFixed(3)),
    end: Number((current.endMs / 1000).toFixed(3)),
    ...(confidence === undefined ? {} : { confidence }),
  });
}

export function wordsFromWhisperJson(raw: WhisperJson): WordTiming[] {
  const segmentsRaw = Array.isArray(raw.transcription)
    ? raw.transcription
    : Array.isArray(raw.segments)
      ? raw.segments
      : [];
  const output: WordTiming[] = [];
  let current: { text: string; startMs: number; endMs: number; confidences: number[] } | null = null;

  for (const segmentRaw of segmentsRaw) {
    if (!segmentRaw || typeof segmentRaw !== "object" || Array.isArray(segmentRaw)) {
      continue;
    }
    const segment = segmentRaw as WhisperSegment;
    if (!Array.isArray(segment.tokens)) {
      continue;
    }

    for (const tokenRaw of segment.tokens) {
      if (!tokenRaw || typeof tokenRaw !== "object" || Array.isArray(tokenRaw)) {
        continue;
      }
      const token = tokenRaw as WhisperToken;
      const text = typeof token.text === "string" ? token.text : "";
      if (isSpecialToken(text.trim())) {
        continue;
      }
      const from = numberFrom(token.offsets?.from);
      const to = numberFrom(token.offsets?.to);
      if (from === undefined || to === undefined || to < from) {
        continue;
      }

      const trimmed = text.trim();
      const confidence = numberFrom(token.p);
      if (isPunctuationToken(trimmed)) {
        if (current) {
          current.text += trimmed;
          current.endMs = to;
          if (confidence !== undefined) {
            current.confidences.push(confidence);
          }
        }
        continue;
      }

      if (/^\s/.test(text) || current === null) {
        pushCurrent(output, current);
        current = {
          text: trimmed,
          startMs: from,
          endMs: to,
          confidences: confidence === undefined ? [] : [confidence],
        };
        continue;
      }

      current.text += trimmed;
      current.endMs = to;
      if (confidence !== undefined) {
        current.confidences.push(confidence);
      }
    }
  }

  pushCurrent(output, current);
  return output;
}

async function runWhisperCli(binary: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`whisper-cli failed (${code}): ${stderr.slice(-500)}`));
    });
  });
}

export async function runWhisperCliWordTimings(
  audioPath: string,
  options: WhisperTimingOptions = {},
): Promise<WordTimingResult> {
  const binary =
    options.whisper_binary ||
    (await resolveFirstExisting(["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"])) ||
    "whisper-cli";
  const model =
    options.whisper_model ||
    process.env.NARRATIONLAYER_WHISPER_MODEL ||
    (await resolveFirstExisting([
      "~/.cache/whisper/ggml-large-v3-turbo.bin",
      "~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin",
      "~/.cache/whisper/ggml-base.en.bin",
      "~/.cache/whisper/ggml-base.bin",
    ]));
  if (!model) {
    throw new Error("No whisper model found for word timing alignment");
  }

  const outputBase = path.join(os.tmpdir(), `narrationlayer-whisper-${randomUUID()}`);
  await runWhisperCli(binary, [
    "-m",
    model,
    "-f",
    audioPath,
    "-l",
    options.language || "en",
    "-oj",
    "-ojf",
    "-of",
    outputBase,
    "-np",
  ]);
  const outputPath = `${outputBase}.json`;
  try {
    const raw = JSON.parse(await readFile(outputPath, "utf8")) as WhisperJson;
    return {
      source: "whisper-cli",
      words: wordsFromWhisperJson(raw),
    };
  } finally {
    await rm(outputPath, { force: true });
  }
}

import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { probeAudioDurationSeconds } from "../audio.js";
import type {
  NormalizedNarrationSegment,
  RenderManifestSegment,
  WordTiming,
  WordsFile,
} from "../schema.js";
import { normalizeForSpeech } from "../text-normalize.js";
import { getWordsFromScript } from "./voicelayer-qwen3.js";
import type { RenderSegmentOptions } from "./types.js";

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

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function estimateDurationFromWords(wordCount: number): number {
  return Number((Math.max(wordCount, 1) / 2.5).toFixed(2));
}

function safeOutputExt(value: string | undefined): string {
  const normalized = (value || "wav").trim().replace(/^\./, "");
  if (!/^[A-Za-z0-9]+$/.test(normalized)) {
    return "wav";
  }
  return normalized.toLowerCase();
}

function expandTemplate(value: string, tokens: Record<string, string>): string {
  return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => tokens[key] ?? match);
}

function estimateWordTimings(words: string[], durationSeconds: number): WordTiming[] {
  const normalized = words.length ? words : ["[segment]"];
  const unit = durationSeconds / normalized.length;
  return normalized.map((word, index) => ({
    index,
    word,
    start: Number((unit * index).toFixed(3)),
    end: Number((unit * (index + 1)).toFixed(3)),
  }));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export async function renderSegment(
  segmentId: string,
  segment: NormalizedNarrationSegment,
  options: RenderSegmentOptions,
  config: ExternalCommandConfig = {},
): Promise<RenderManifestSegment> {
  if (!config.command) {
    throw new Error("external-command requires render.command");
  }

  const normalizedScript = normalizeForSpeech(segment.script);
  const artifactsRoot = path.join(options.artifactsDir, "segments", segmentId);
  await mkdir(artifactsRoot, { recursive: true });
  const outputExt = safeOutputExt(config.output_ext);
  const audioPath = path.join(artifactsRoot, `${segmentId}.${outputExt}`);
  const wordsPath = path.join(artifactsRoot, "words.json");
  const referenceText: string =
    config.reference_text !== undefined
      ? config.reference_text
      : config.reference_text_path
        ? await readFile(config.reference_text_path, "utf8").then((text) => text.trim())
        : "";
  const tokens: Record<string, string> = {
    output_path: audioPath,
    segment_id: segmentId,
    job_id: options.jobId || "",
    voice_profile: options.voiceProfile || "",
    title: segment.title,
    script: normalizedScript,
    duration_seconds: segment.duration_seconds === undefined ? "" : String(segment.duration_seconds),
    reference_clip: config.reference_clip || "",
    reference_text: referenceText,
    reference_text_path: config.reference_text_path || "",
  };
  const args = (config.args || []).map((arg) => expandTemplate(arg, tokens));
  const result = await runCommand(config.command, args, {
    cwd: config.cwd,
    timeoutMs: config.timeout_ms ?? 120000,
  });

  if (result.timedOut) {
    throw new Error(`external-command timed out after ${config.timeout_ms ?? 120000}ms`);
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`external-command exited ${result.code}${detail ? `: ${detail}` : ""}`);
  }
  if (!(await fileExists(audioPath))) {
    throw new Error(`external-command did not create expected audio: ${audioPath}`);
  }

  const words = getWordsFromScript(normalizedScript);
  const durationSeconds =
    (await (config.audio_duration_probe ?? probeAudioDurationSeconds)(audioPath)) ??
    segment.duration_seconds ??
    estimateDurationFromWords(words.length);
  const wordsPayload: WordsFile = {
    job_id: options.jobId || "",
    segment_id: segmentId,
    timing:
      config.timing_backend === "none"
        ? {
            status: "unavailable",
            source: "estimated",
            reason: "external-command timing disabled",
          }
        : {
            status: "available",
            source: "estimated",
          },
    words: config.timing_backend === "none" ? [] : estimateWordTimings(words, durationSeconds),
  };
  await writeFile(wordsPath, JSON.stringify(wordsPayload, null, 2), "utf8");

  return {
    id: segmentId,
    title: segment.title,
    script: normalizedScript,
    audio_path: audioPath,
    duration_seconds: Number(durationSeconds.toFixed(3)),
    words_path: wordsPath,
    status: "rendered",
  };
}

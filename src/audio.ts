import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AudioAssemblyChunk {
  audioPath: string;
  pauseAfterSeconds: number;
}

export interface TrimAudioSilenceOptions {
  thresholdDb?: number;
  startSilenceSeconds?: number;
  stopSilenceSeconds?: number;
  tailSilenceSeconds?: number;
  tailWindowSeconds?: number;
}

export interface DetectedSilence {
  start: number;
  end: number;
  duration: number;
}

async function runCommand(
  command: string,
  args: string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? stdout : null));
  });
}

async function runCommandWithStderr(
  command: string,
  args: string[],
): Promise<{ code: number; stderr: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

async function runRequiredCommand(
  command: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function cleanDuration(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Number(value.toFixed(3));
}

export async function probeAudioDurationSeconds(
  audioPath: string,
): Promise<number | undefined> {
  const ffprobe = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nokey=1:noprint_wrappers=1",
    audioPath,
  ]);
  if (ffprobe) {
    const duration = cleanDuration(Number.parseFloat(ffprobe.trim()));
    if (duration !== undefined) {
      return duration;
    }
  }

  const afinfo = await runCommand("afinfo", [audioPath]);
  if (afinfo) {
    const match = afinfo.match(/estimated duration:\s*([0-9.]+)/i);
    if (match) {
      return cleanDuration(Number.parseFloat(match[1]));
    }
  }

  return undefined;
}

function escapeConcatPath(filePath: string): string {
  return path.resolve(filePath).replace(/'/g, "'\\''");
}

export async function assembleAudioWithSilence(
  chunks: AudioAssemblyChunk[],
  outputPath: string,
): Promise<void> {
  if (chunks.length === 0) {
    throw new Error("Cannot assemble audio without chunks");
  }

  if (chunks.length === 1 && chunks[0].pauseAfterSeconds <= 0) {
    await copyFile(chunks[0].audioPath, outputPath);
    return;
  }

  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "narrationlayer-audio-"),
  );
  try {
    const concatFiles: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      concatFiles.push(chunk.audioPath);
      if (chunk.pauseAfterSeconds > 0) {
        const silencePath = path.join(tempDir, `silence-${index + 1}.mp3`);
        await runRequiredCommand("ffmpeg", [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=channel_layout=mono:sample_rate=24000",
          "-t",
          String(chunk.pauseAfterSeconds),
          "-codec:a",
          "libmp3lame",
          "-q:a",
          "9",
          silencePath,
        ]);
        concatFiles.push(silencePath);
      }
    }

    const concatListPath = path.join(tempDir, "concat.txt");
    await writeFile(
      concatListPath,
      concatFiles
        .map((filePath) => `file '${escapeConcatPath(filePath)}'`)
        .join("\n"),
      "utf8",
    );
    await runRequiredCommand("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-codec:a",
      "copy",
      outputPath,
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function parseSilenceDetectOutput(output: string): DetectedSilence[] {
  const silences: DetectedSilence[] = [];
  let pendingStart: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(
      /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/,
    );
    if (endMatch && pendingStart !== undefined) {
      silences.push({
        start: Number(pendingStart.toFixed(3)),
        end: Number(Number(endMatch[1]).toFixed(3)),
        duration: Number(Number(endMatch[2]).toFixed(3)),
      });
      pendingStart = undefined;
    }
  }
  return silences;
}

export async function detectSilences(
  audioPath: string,
  thresholdDb: number,
  minDurationSeconds: number,
): Promise<DetectedSilence[]> {
  const result = await runCommandWithStderr("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    audioPath,
    "-af",
    `silencedetect=noise=${thresholdDb}dB:d=${minDurationSeconds}`,
    "-f",
    "null",
    "-",
  ]);
  if (!result || result.code !== 0) {
    return [];
  }
  return parseSilenceDetectOutput(result.stderr);
}

export function findTailCutoffSeconds(
  silences: DetectedSilence[],
  durationSeconds: number,
  options: {
    minSilenceSeconds: number;
    tailWindowSeconds: number;
    paddingSeconds: number;
  },
): number | undefined {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return undefined;
  }
  let candidate: DetectedSilence | undefined;
  for (let index = silences.length - 1; index >= 0; index -= 1) {
    const silence = silences[index];
    if (
      silence.duration >= options.minSilenceSeconds &&
      silence.start > 0.4 &&
      silence.end >= durationSeconds - options.tailWindowSeconds
    ) {
      candidate = silence;
      break;
    }
  }
  if (!candidate) {
    return undefined;
  }
  const cutoff = candidate.start + options.paddingSeconds;
  if (cutoff <= 0 || cutoff >= durationSeconds - 0.08) {
    return undefined;
  }
  return Number(cutoff.toFixed(3));
}

async function truncateAudio(
  inputPath: string,
  outputPath: string,
  durationSeconds: number,
): Promise<void> {
  await runRequiredCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-t",
    String(durationSeconds),
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "3",
    outputPath,
  ]);
}

export interface AudioEqOptions {
  /** High-shelf corner frequency in Hz. */
  highshelfHz?: number;
  /** High-shelf gain in dB (positive lifts highs, de-muffling). */
  highshelfGainDb?: number;
}

/**
 * Apply a high-shelf EQ to lift high-frequency energy (de-muffle). If neither
 * parameter is provided this is a no-op copy so callers can always route through
 * it. Mirrors the trim/assemble ffmpeg helpers: re-encode with libmp3lame at the
 * same q:a 3 quality used by the trim path so the EQ'd chunk stays consistent.
 */
export async function applyAudioEq(
  inputPath: string,
  outputPath: string,
  options: AudioEqOptions = {},
): Promise<void> {
  const { highshelfHz, highshelfGainDb } = options;
  if (highshelfHz === undefined && highshelfGainDb === undefined) {
    await copyFile(inputPath, outputPath);
    return;
  }
  const hz = highshelfHz ?? 4000;
  const gain = highshelfGainDb ?? 0;
  await runRequiredCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-af",
    `highshelf=f=${hz}:g=${gain}`,
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "3",
    outputPath,
  ]);
}

export async function trimAudioSilence(
  inputPath: string,
  outputPath: string,
  options: TrimAudioSilenceOptions = {},
): Promise<void> {
  const threshold = `${options.thresholdDb ?? -38}dB`;
  const thresholdNumber = options.thresholdDb ?? -38;
  const startSilence = options.startSilenceSeconds ?? 0.12;
  const stopSilence = options.stopSilenceSeconds ?? 0.1;
  await runRequiredCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-af",
    `silenceremove=start_periods=1:start_silence=${startSilence}:start_threshold=${threshold},areverse,silenceremove=start_periods=1:start_silence=${stopSilence}:start_threshold=${threshold},areverse`,
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "3",
    outputPath,
  ]);

  const duration = await probeAudioDurationSeconds(outputPath);
  if (!duration) {
    return;
  }
  const tailSilenceSeconds = options.tailSilenceSeconds ?? 0.35;
  const silences = await detectSilences(outputPath, thresholdNumber, 0.08);
  const cutoff = findTailCutoffSeconds(silences, duration, {
    minSilenceSeconds: tailSilenceSeconds,
    tailWindowSeconds: options.tailWindowSeconds ?? 1,
    paddingSeconds: stopSilence,
  });
  if (cutoff === undefined) {
    return;
  }
  const tempPath = `${outputPath}.tailtrim.mp3`;
  await truncateAudio(outputPath, tempPath, cutoff);
  await rename(tempPath, outputPath);
}

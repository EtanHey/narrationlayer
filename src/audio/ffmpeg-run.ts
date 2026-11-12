import { spawn } from "node:child_process";
import { buildMonoS16WavArgs, buildAtempoArgs, buildLoudnessNormalizeArgs, type MonoS16WavOptions } from "./ffmpeg-args.js";

export function ffmpegToMonoS16Wav(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  options: MonoS16WavOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      buildMonoS16WavArgs(inputPath, outputPath, sampleRate, options),
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

export function ffmpegRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

export function ffmpegAtempo(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  v: number,
): Promise<void> {
  return ffmpegRun(buildAtempoArgs(inputPath, outputPath, sampleRate, v));
}

/** Measure a WAV's mean_volume (dB) via ffmpeg volumedetect; null if unmeasurable. */
export function measureMeanVolumeDb(inputPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        inputPath,
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    ff.on("error", () => resolve(null));
    ff.on("close", () => {
      const match = stderr.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
      if (!match) {
        resolve(null);
        return;
      }
      const value = Number.parseFloat(match[1]);
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}

export function ffmpegLoudnessNormalize(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  gainDb: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      buildLoudnessNormalizeArgs(inputPath, outputPath, sampleRate, gainDb),
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

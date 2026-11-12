import path from "node:path";

export interface MonoS16WavOptions {
  /** De-muffle high-shelf EQ frequency (Hz). Profile-gated; only set for eq-bearing profiles. */
  eqHighshelfHz?: number;
  /** De-muffle high-shelf EQ gain (dB). */
  eqHighshelfGainDb?: number;
}

/**
 * Build the ffmpeg argv for the single mono s16le WAV pass. Exported for tests.
 * When EITHER eq param is set, a `highshelf=f=<hz>:g=<gain>` filter (mirroring
 * src/audio.ts applyAudioEq, same defaults hz=4000/g=0) is composed into a single
 * `-af` — no second re-encode pass. When neither is set, no `-af` is added.
 */
export function buildMonoS16WavArgs(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  options: MonoS16WavOptions = {},
): string[] {
  const { eqHighshelfHz, eqHighshelfGainDb } = options;
  // -ac 1 (mono), -c:a pcm_s16le (16-bit PCM), -ar <rate> (target sample rate).
  const args = ["-y", "-i", inputPath, "-ac", "1", "-ar", String(sampleRate)];
  if (eqHighshelfHz !== undefined || eqHighshelfGainDb !== undefined) {
    const hz = eqHighshelfHz ?? 4000;
    const gain = eqHighshelfGainDb ?? 0;
    args.push("-af", `highshelf=f=${hz}:g=${gain}`);
  }
  args.push("-c:a", "pcm_s16le", outputPath);
  return args;
}

/**
 * Compute the dB gain needed to bring a measured mean_volume up/down to a target.
 * gainDb = target - measured. Exported for tests.
 */
export function computeLoudnessGainDb(
  measuredMeanVolumeDb: number,
  targetDb: number,
): number {
  return targetDb - measuredMeanVolumeDb;
}

/**
 * Build the ffmpeg argv for the loudness-normalize re-encode pass. Applies
 * `volume=<gainDb>dB` to hit the target RMS, followed by `alimiter=limit=0.95`
 * to prevent clipping on boost, keeping mono/s16le/sampleRate. Exported for tests.
 */
export function buildLoudnessNormalizeArgs(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  gainDb: number,
): string[] {
  return [
    "-y",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-af",
    `volume=${gainDb}dB,alimiter=limit=0.95`,
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}

/**
 * Build the ffmpeg argv for the per-profile ATEMPO (speed) pass. `atempo=<v>` is a
 * pitch-PRESERVING tempo change (no timbre / identity shift), so slowing a clone to
 * v=0.90 lengthens it ~11% without lowering its pitch. We re-assert mono / target
 * sample rate / s16le so the output stays a clean AfterCode-readable WAV. Exported
 * for tests. Runs AFTER ffmpegToMonoS16Wav and BEFORE loudness normalization.
 */
export function buildAtempoArgs(
  inputPath: string,
  outputPath: string,
  sampleRate: number,
  v: number,
): string[] {
  return [
    "-y",
    "-i",
    inputPath,
    "-af",
    `atempo=${v}`,
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}

/**
 * Build the ffmpeg argv for a PCM (s16le) silence clip of `seconds` duration.
 * CRITICAL: we generate silence as PCM (NOT mp3) so the silence shares the exact
 * WAV codec/rate/layout as the synthesized pieces; this lets the final assembly use
 * `concat -c copy` WITHOUT the non-monotonic-DTS error that an mp3-silence segment
 * triggers on the WAV demuxer path. Exported for tests.
 */
export function buildPcmSilenceArgs(
  outputPath: string,
  seconds: number,
  sampleRate: number,
): string[] {
  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=mono:sample_rate=${sampleRate}`,
    "-t",
    String(seconds),
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}

export function escapeConcatPath(filePath: string): string {
  return path.resolve(filePath).replace(/'/g, "'\\''");
}

/**
 * Build the ffmpeg argv for the `concat` demuxer stream-copy over a WAV concat list.
 * `-c copy` is safe ONLY because every entry (pieces + PCM silence) is mono s16le at
 * the same sample rate. Exported for tests.
 */
export function buildWavConcatArgs(
  concatListPath: string,
  outputPath: string,
): string[] {
  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatListPath,
    "-c",
    "copy",
    outputPath,
  ];
}

import { rename } from "node:fs/promises";
import { computeLoudnessGainDb } from "../../audio/ffmpeg-args.js";
import { measureMeanVolumeDb, ffmpegLoudnessNormalize } from "../../audio/ffmpeg-run.js";

/**
 * 2-pass RMS loudness normalize: measure the WAV's mean_volume, compute the gain
 * to hit targetDb, then re-encode applying that gain + a limiter into a temp file
 * and rename over the output. Runs AFTER the highshelf EQ pass so the final body
 * RMS is exactly the target regardless of the EQ tone shaping (→ consistent across
 * segments). No-op (returns false) if the volume could not be measured.
 */
export async function loudnessNormalizeInPlace(
  output: string,
  sampleRate: number,
  targetDb: number,
): Promise<{ applied: boolean; measuredDb?: number; gainDb?: number }> {
  const measuredDb = await measureMeanVolumeDb(output);
  if (measuredDb === null) {
    return { applied: false };
  }
  const gainDb = computeLoudnessGainDb(measuredDb, targetDb);
  const tmpPath = `${output}.loud.wav`;
  await ffmpegLoudnessNormalize(output, tmpPath, sampleRate, gainDb);
  await rename(tmpPath, output);
  return { applied: true, measuredDb, gainDb };
}

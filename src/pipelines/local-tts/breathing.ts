import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { breathingV1, toBreathingPieces } from "../../plan/index.js";
import { buildPcmSilenceArgs, escapeConcatPath, buildWavConcatArgs } from "../../audio/ffmpeg-args.js";
import { ffmpegRun, ffmpegToMonoS16Wav, ffmpegAtempo } from "../../audio/ffmpeg-run.js";
import { synthesize } from "./synthesis.js";
import { RunnerFailure } from "./failure.js";

/**
 * BREATHING stage: re-synthesize the whole-segment text as discrete sentence/clause
 * pieces, mono-s16 each, then concat them interleaved with PCM silence pads so the
 * voice "breathes" between sentences. Profile-gated; runs AFTER atempo, BEFORE
 * loudness. Overwrites `output` in place with the assembled, padded WAV.
 */
export async function applyBreathingInPlace(opts: {
  output: string;
  sampleRate: number;
  spokenText: string;
  sentencePad: number;
  commaPad: number;
  daemonUrl: string;
  authToken: string;
  referenceClip: string;
  referenceText: string;
  timeoutMs: number;
  eqHighshelfHz?: number;
  eqHighshelfGainDb?: number;
  atempo?: number;
}): Promise<{ applied: boolean; pieces: number }> {
  const pieces = toBreathingPieces(breathingV1(
    opts.spokenText,
    opts.sentencePad,
    opts.commaPad,
  ));
  // Nothing to interleave: 0 or 1 piece => leave the whole-segment WAV untouched.
  if (pieces.length < 2) {
    return { applied: false, pieces: pieces.length };
  }

  const dir = path.dirname(opts.output);
  const base = path.basename(opts.output);
  const concatEntries: string[] = [];
  const cleanup: string[] = [];
  let preserveIntermediates = false;
  try {
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      // Synthesize this piece via the SAME daemon path as the whole segment.
      const audioBuf = await synthesize({
        daemonUrl: opts.daemonUrl,
        authToken: opts.authToken,
        referenceClip: opts.referenceClip,
        referenceText: opts.referenceText,
        text: piece.text,
        timeoutMs: opts.timeoutMs,
      });
      const rawPath = path.join(dir, `${base}.breath-${i}.raw`);
      const wavPath = path.join(dir, `${base}.breath-${i}.wav`);
      cleanup.push(rawPath, wavPath);
      await writeFile(rawPath, audioBuf);
      await ffmpegToMonoS16Wav(rawPath, wavPath, opts.sampleRate, {
        eqHighshelfHz: opts.eqHighshelfHz,
        eqHighshelfGainDb: opts.eqHighshelfGainDb,
      });
      // Apply atempo PER PIECE (before silence) so the speech is sped/slowed but the
      // PCM-silence breaths keep their EXACT profile pad durations.
      if (opts.atempo !== undefined) {
        const tempoPath = path.join(dir, `${base}.breath-${i}.tempo.wav`);
        cleanup.push(tempoPath);
        await ffmpegAtempo(wavPath, tempoPath, opts.sampleRate, opts.atempo);
        concatEntries.push(tempoPath);
      } else {
        concatEntries.push(wavPath);
      }
      // Interleave a PCM-silence breath after every piece except the last.
      if (piece.padAfterSeconds > 0 && i < pieces.length - 1) {
        const silPath = path.join(dir, `${base}.sil-${i}.wav`);
        cleanup.push(silPath);
        await ffmpegRun(
          buildPcmSilenceArgs(silPath, piece.padAfterSeconds, opts.sampleRate),
        );
        concatEntries.push(silPath);
      }
    }

    const listPath = path.join(dir, `${base}.breath.concat.txt`);
    cleanup.push(listPath);
    await writeFile(
      listPath,
      concatEntries.map((p) => `file '${escapeConcatPath(p)}'`).join("\n"),
      "utf8",
    );
    const assembled = path.join(dir, `${base}.breath.out.wav`);
    cleanup.push(assembled);
    await ffmpegRun(buildWavConcatArgs(listPath, assembled));
    await rename(assembled, opts.output);
    // `assembled` was renamed onto output; drop it from cleanup-removal set.
    cleanup.splice(cleanup.indexOf(assembled), 1);
    return { applied: true, pieces: pieces.length };
  } catch (error) {
    // Match the former immediate exit on HTTP/missing-audio failures. Ordinary
    // thrown failures (including timeouts and ffmpeg errors) still clean up.
    preserveIntermediates = error instanceof RunnerFailure;
    throw error;
  } finally {
    const { unlink } = await import("node:fs/promises");
    for (const p of preserveIntermediates ? [] : cleanup) {
      try {
        await unlink(p);
      } catch {
        /* best effort */
      }
    }
  }
}

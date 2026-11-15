import { writeFile, mkdir, stat, rename, copyFile, cp, mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { runWhisperCliWordTimings } from "../../word-timings.js";
import { pitchRunaway, wordMismatches, type RecognisedWord, type WordCheckSetting } from "../../quality/take-checks.js";
import type { TakeCheckReceipt } from "./take-cache.js";
import type { SpeechChannels, TermRule } from "../../text-normalize.js";
import { ffmpegToMonoS16Wav, ffmpegAtempo } from "../../audio/ffmpeg-run.js";
import { synthesize } from "./synthesis.js";
import { RunnerFailure, TakeCheckError } from "./failure.js";
import { applyBreathingInPlace } from "./breathing.js";
import { loudnessNormalizeInPlace } from "./loudness.js";
import { computeContentHashKey, writeTakeCacheReceipt, type CacheKeyParams } from "./take-cache.js";
import { assertKeepPiecesDir, keepPieces } from "./keep-pieces.js";

export interface ResolvedLocalTtsVoice extends CacheKeyParams {
  referenceClip: string;
  referenceText: string;
  daemonUrl: string;
  profileId?: string;
  profileVersion?: string;
  model?: string;
}

export interface LocalTtsRenderOptions {
  takeChecks?: { pitchCeilingHz: number; retries: number; wordCheckSetting?: WordCheckSetting; commonWords?: ReadonlySet<string> };
  recogniseTake?: (wav: string) => Promise<readonly RecognisedWord[]>;
  text: string;
  output: string;
  sampleRate: number;
  resolved: ResolvedLocalTtsVoice;
  authToken: string;
  cacheDir: string;
  cache: boolean;
  /** Render even on a cache HIT and replace the cached take with the new one. Needs `cache`. */
  refreshCache?: boolean;
  /** Copy each piece's audio as joined, plus `pieces.json`, into this new or empty directory. */
  keepPiecesDir?: string;
  timeoutMs: number;
  prepareSpeechChannels: (text: string, pronunciationRules: TermRule[]) => SpeechChannels;
}

export type LocalTtsRenderResult =
  | { kind: "cache-hit"; cacheKey: string; cachePath: string; bytes: number; piecesNote: string }
  | { kind: "rendered"; cacheKey: string; bytes: number; atempoNote: string; breathingNote: string; loudnessNote: string; cacheNote: string; piecesNote: string };

const PIECES_ON_HIT = "cache hit: no pieces were rendered";

/** Render one resolved voice configuration without owning the caller's process. */
async function renderUnchecked(args: LocalTtsRenderOptions, store = true): Promise<LocalTtsRenderResult> {
  const { output, resolved, authToken, cacheDir, prepareSpeechChannels, keepPiecesDir } = args;
  if (args.refreshCache && !args.cache) throw new RunnerFailure("--refresh-cache cannot be combined with --no-cache");
  if (keepPiecesDir !== undefined) await assertKeepPiecesDir(keepPiecesDir);
  // Pronunciation normalization (the TERM_MAP respellings) MUST happen here,
  // before the daemon, exactly as renderSegment does. The DISPLAY is unaffected:
  // the build reads the script .md, not this runner's TTS-feed text.
  const channels = prepareSpeechChannels(args.text, []);
  const spokenText = channels?.synthInput;
  if (typeof spokenText !== "string" || !spokenText.trim())
    throw new RunnerFailure("speech preparation must return a nonblank synthInput string synchronously");

  // CONTENT-HASH FREEZE (determinism layer). The key is computed over the literal
  // spoken text + reference identity + the OUTPUT-affecting synth params. On a HIT
  // we copy the FROZEN accepted take to the output and skip the non-deterministic
  // daemon entirely; on a MISS we synth normally, then store the final WAV under the
  // key — freezing this take for every future identical request.
  const cacheParams: CacheKeyParams = {
    eqHighshelfHz: resolved.eqHighshelfHz,
    eqHighshelfGainDb: resolved.eqHighshelfGainDb,
    loudnessTargetDb: resolved.loudnessTargetDb,
    atempo: resolved.atempo,
    sentencePauseSeconds: resolved.sentencePauseSeconds,
    commaPauseSeconds: resolved.commaPauseSeconds,
    takeChecks: args.takeChecks,
  };
  const cacheKey = computeContentHashKey({
    spokenText,
    referenceClip: resolved.referenceClip,
    referenceText: resolved.referenceText,
    profileId: resolved.profileId,
    profileVersion: resolved.profileVersion,
    model: resolved.model,
    params: cacheParams,
  });
  const cachePath = path.join(cacheDir, `${cacheKey}.wav`);
  if (args.cache && !args.refreshCache && existsSync(cachePath)) {
    await copyFile(cachePath, output);
    const hitInfo = await stat(output).catch(() => undefined);
    if (!hitInfo || hitInfo.size === 0) {
      throw new RunnerFailure(`cache HIT but frozen WAV is empty or unreadable: ${cachePath}`);
    }
    // Commit synth provenance only after the selected WAV is known non-empty.
    // A failed rerun must never pair new sidecar bytes with an older output.
    await writeFile(`${output}.spoken.txt`, spokenText, "utf8");
    // A HIT renders nothing, so it has no pieces to keep: say so instead of re-rendering.
    const keptPieces = keepPiecesDir === undefined ? undefined : { dir: keepPiecesDir, count: 0, skipped: PIECES_ON_HIT };
    await writeTakeCacheReceipt(output, cacheKey, { cacheEnabled: args.cache, keptPieces });
    const piecesNote = keptPieces ? ` pieces=skipped(${PIECES_ON_HIT})` : "";
    return { kind: "cache-hit", cacheKey, cachePath, bytes: hitInfo.size, piecesNote };
  }

  const audioBuf = await synthesize({
    daemonUrl: resolved.daemonUrl,
    authToken,
    referenceClip: resolved.referenceClip,
    referenceText: resolved.referenceText,
    model: resolved.model,
    text: spokenText,
    timeoutMs: args.timeoutMs,
  });

  // Write raw daemon audio to a temp file beside output, then transcode to mono s16 WAV.
  const rawPath = `${output}.raw`;
  await writeFile(rawPath, audioBuf);
  try {
    await ffmpegToMonoS16Wav(rawPath, output, args.sampleRate, {
      eqHighshelfHz: resolved.eqHighshelfHz,
      eqHighshelfGainDb: resolved.eqHighshelfGainDb,
    });
  } finally {
    try {
      await (await import("node:fs/promises")).unlink(rawPath);
    } catch {
      /* best effort */
    }
  }

  // PER-PROFILE ATEMPO (speed) + BREATHING (pauses), applied AFTER the mono-s16 pass
  // (so they share the EQ'd body) and BEFORE loudness normalization.
  //   - atempo: pitch-PRESERVING tempo change (no timbre / identity shift).
  //   - breathing: re-synthesize the segment as sentence/clause pieces and interleave
  //     PCM-silence breaths.
  // When breathing is active it applies atempo PER PIECE (so the silence pads keep
  // their EXACT profile durations); the standalone atempo pass below runs ONLY when
  // breathing did not assemble (so a non-breathing profile still gets its speed change).
  let atempoNote =
    resolved.atempo !== undefined ? ` atempo=${resolved.atempo}` : "";
  let breathingNote = "";
  let breathingApplied = false;
  let piecesKept: number | undefined;
  if (
    resolved.sentencePauseSeconds !== undefined ||
    resolved.commaPauseSeconds !== undefined
  ) {
    const sentencePad = resolved.sentencePauseSeconds ?? 0.55;
    const commaPad = resolved.commaPauseSeconds ?? 0.22;
    const breath = await applyBreathingInPlace({
      output,
      sampleRate: args.sampleRate,
      spokenText,
      sentencePad,
      commaPad,
      daemonUrl: resolved.daemonUrl,
      authToken,
      referenceClip: resolved.referenceClip,
      referenceText: resolved.referenceText,
      timeoutMs: args.timeoutMs,
      eqHighshelfHz: resolved.eqHighshelfHz,
      eqHighshelfGainDb: resolved.eqHighshelfGainDb,
      atempo: resolved.atempo,
      onJoined: keepPiecesDir === undefined ? undefined : async (pieces) => {
        piecesKept = await keepPieces(keepPiecesDir, pieces);
      },
    });
    breathingApplied = breath.applied;
    breathingNote = breath.applied
      ? ` breathing=${breath.pieces}pc(sent=${sentencePad}s,comma=${commaPad}s)`
      : ` breathing=skipped(${breath.pieces}pc)`;
  }

  // Standalone atempo: only when breathing did NOT assemble (breathing applies atempo
  // per-piece internally). atempo unset => skipped (behavior unchanged).
  if (resolved.atempo !== undefined && !breathingApplied) {
    const tmpPath = `${output}.atempo.wav`;
    try {
      await ffmpegAtempo(output, tmpPath, args.sampleRate, resolved.atempo);
      await rename(tmpPath, output);
    } catch (err) {
      try {
        await (await import("node:fs/promises")).unlink(tmpPath);
      } catch {
        /* best effort */
      }
      throw err;
    }
  }
  // Not cut into pieces: the whole take, as it stands before loudness, is the one piece.
  if (keepPiecesDir !== undefined && !breathingApplied) {
    piecesKept = await keepPieces(keepPiecesDir, [{ text: spokenText, audioPath: output }]);
  }

  // Loudness normalization (profile-gated). Order matters: highshelf EQ ran FIRST
  // (above, shaping the tone), THEN we RMS-normalize so the final body is exactly
  // the target regardless of the EQ — making body loudness consistent across every
  // segment. Unset target => behavior unchanged (skipped).
  let loudnessNote = "";
  if (resolved.loudnessTargetDb !== undefined) {
    const norm = await loudnessNormalizeInPlace(
      output,
      args.sampleRate,
      resolved.loudnessTargetDb,
    );
    loudnessNote = norm.applied
      ? ` loudness=${resolved.loudnessTargetDb}dB (measured ${norm.measuredDb?.toFixed(2)}dB, gain ${norm.gainDb?.toFixed(2)}dB)`
      : ` loudness=${resolved.loudnessTargetDb}dB (skipped: unmeasurable)`;
  }

  const info = await stat(output).catch(() => undefined);
  if (!info || info.size === 0)
    throw new RunnerFailure(`output WAV is empty or missing: ${output}`);

  // Persist the literal daemon input only after every output-affecting pass and
  // final non-empty validation has succeeded. Downstream gates derive approved
  // aliases from these bytes, so publishing them before the WAV is accepted is unsafe.
  await writeFile(`${output}.spoken.txt`, spokenText, "utf8");

  // CONTENT-HASH FREEZE (MISS or REFRESH): store the FINAL processed WAV under the key so
  // this accepted take is frozen for every future identical request. Atomic via temp+rename
  // so a crash mid-write never leaves a truncated frozen take, and a failed store leaves the
  // old entry in place. On a MISS the store is best-effort: a failure must never fail an
  // otherwise-good synth. On a REFRESH replacing the entry is the point, so a failure fails.
  let cacheNote = "";
  if (args.cache && store) {
    try {
      await mkdir(cacheDir, { recursive: true });
      const cacheTmp = `${cachePath}.tmp-${process.pid}`;
      await copyFile(output, cacheTmp);
      await rename(cacheTmp, cachePath);
      cacheNote = args.refreshCache ? ` cache REFRESH->frozen key=${cacheKey}` : ` cache MISS->frozen key=${cacheKey}`;
    } catch (error) {
      if (args.refreshCache)
        throw new RunnerFailure(`--refresh-cache could not store the new take for key=${cacheKey}: ${error instanceof Error ? error.message : String(error)}`);
      cacheNote = ` cache MISS (store failed key=${cacheKey})`;
    }
  }
  const keptPieces = keepPiecesDir === undefined ? undefined : { dir: keepPiecesDir, count: piecesKept ?? 0 };
  await writeTakeCacheReceipt(output, cacheKey, { cacheEnabled: args.cache, refreshed: args.refreshCache === true, keptPieces });
  const piecesNote = keptPieces ? ` pieces=${keptPieces.count} kept in ${keptPieces.dir}` : "";

  return { kind: "rendered", cacheKey, bytes: info.size, atempoNote, breathingNote, loudnessNote, cacheNote, piecesNote };
}

/** Pitch is a gate; word mismatches rank bounded retries without freezing a rejected take. */
export async function renderLocalTts(args: LocalTtsRenderOptions): Promise<LocalTtsRenderResult> {
  const checks = args.takeChecks;
  if (!checks) return renderUnchecked(args);
  if (!Number.isFinite(checks.pitchCeilingHz) || checks.pitchCeilingHz <= 0
    || !Number.isSafeInteger(checks.retries) || checks.retries < 0 || checks.retries > 10)
    throw new TakeCheckError("take checks require a positive pitch ceiling and 0..10 retries");
  if (args.refreshCache && !args.cache) throw new RunnerFailure("--refresh-cache cannot be combined with --no-cache");
  if (args.keepPiecesDir !== undefined) await assertKeepPiecesDir(args.keepPiecesDir);
  const evidence: TakeCheckReceipt = { attempts: 0, failures: [], gaveUp: false };
  const stage = await mkdtemp(`${args.output}.checks-`);
  const output = path.join(stage, "take.wav");
  const pieces = args.keepPiecesDir === undefined ? undefined : path.join(stage, "pieces");
  let refresh = args.refreshCache;
  let key = "";
  const wordAttempts: { source: "cache" | "render"; attempt: number; editCount: number | null }[] = [];
  let best: { count: number; result: LocalTtsRenderResult; source: "cache" | "render";
    wordMatch: NonNullable<TakeCheckReceipt["wordMatch"]>; pitchNote: TakeCheckReceipt["pitchNote"] } | undefined;
  try {
    for (;;) {
      // The existing synthesis path sends a fresh request; the backend supplies variance (no seed API).
      let result = await renderUnchecked({ ...args, output, keepPiecesDir: pieces,
        cache: args.cache && !refresh && evidence.attempts === 0 && evidence.failures.length === 0, refreshCache: false }, false);
      key = result.cacheKey;
      let source: "cache" | "render" = result.kind === "cache-hit" ? "cache" : "render";
      if (source === "render") evidence.attempts++;
      const pitch = (() => {
        try {
      const decoded = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", output,
        "-ar", "8000", "-ac", "1", "-f", "f32le", "pipe:1"], { maxBuffer: 256 * 1024 * 1024 });
      if (decoded.error || decoded.status !== 0 || !decoded.stdout.length) throw new RunnerFailure("take check audio decode failed");
      const samples = new Float32Array(decoded.stdout.length / 4);
      for (let i = 0; i < samples.length; i++) samples[i] = decoded.stdout.readFloatLE(i * 4);
      return pitchRunaway(samples, 8000, checks.pitchCeilingHz);
        } catch {
          throw new TakeCheckError("take check execution failed; no retry performed");
        }
      })();
      const tooShort = pitch.windows.length === 0;
      if (tooShort) evidence.pitchNote = "not judged: shorter than one window";
      else delete evidence.pitchNote;
      let reason = tooShort ? undefined : pitch.worstMedianHz === null ? "pitch-unmeasurable" : pitch.failed ? "pitch-over-ceiling" : undefined;
      const pitchFailed = reason !== undefined;
      let wordFailed = false;
      if (!reason) {
        try {
          const spoken = await readFile(`${output}.spoken.txt`, "utf8");
          if (!/[a-z0-9]/i.test(spoken)) {
            wordAttempts.push({ source, attempt: evidence.attempts, editCount: null });
            evidence.wordMatch = { pass: true, setting: checks.wordCheckSetting ?? "a", attempts: wordAttempts,
              edits: [], note: "not judged: no Latin-script words", model: "not-run" };
          } else {
          const modelPath = path.join(os.homedir(), ".cache/whisper/ggml-large-v3-turbo.bin");
          if (!args.recogniseTake && !existsSync(modelPath)) throw new Error(`take checks require model: ${modelPath}`);
          const words = args.recogniseTake ? await args.recogniseTake(output)
            : (await runWhisperCliWordTimings(output, { output_directory: stage, whisper_model: modelPath })).words;
          const wordMatch = wordMismatches(spoken, words,
            { setting: checks.wordCheckSetting, commonWords: checks.commonWords });
          wordAttempts.push({ source, attempt: evidence.attempts, editCount: wordMatch.edits.length });
          wordFailed = !wordMatch.pass;
          evidence.wordMatch = { pass: wordMatch.pass, setting: wordMatch.setting, attempts: wordAttempts,
            model: args.recogniseTake ? "injected-recognizer" : "ggml-large-v3-turbo.bin",
            edits: wordMatch.edits.map(({ kind, sentIndex, recognisedIndex, start, end }) => ({ kind, sentIndex, recognisedIndex, start, end })) };
          if (!wordMatch.pass) reason = `word-mismatch:${JSON.stringify(wordMatch.edits.map(({ kind, sentIndex, start, end }) => ({ kind, sentIndex, start, end })))}`;
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : "unknown recognition error";
          throw new TakeCheckError(`word check execution failed; no retry performed: ${detail}`);
        }
      }
      if (pitchFailed) wordAttempts.push({ source, attempt: evidence.attempts, editCount: null });
      if (reason) evidence.failures.push({ source, attempt: evidence.attempts, reason });
      if (wordFailed && evidence.wordMatch && (!best || evidence.wordMatch.edits.length < best.count)) {
        best = { count: evidence.wordMatch.edits.length, result, source,
          wordMatch: evidence.wordMatch, pitchNote: evidence.pitchNote };
        await copyFile(output, path.join(stage, "best.wav"));
        await copyFile(`${output}.spoken.txt`, path.join(stage, "best.spoken.txt"));
        if (pieces) {
          await rm(path.join(stage, "best-pieces"), { recursive: true, force: true });
          if (existsSync(pieces)) await cp(pieces, path.join(stage, "best-pieces"), { recursive: true });
        }
      }
      if (reason && best && evidence.attempts >= checks.retries + 1) {
        await copyFile(path.join(stage, "best.wav"), output);
        await copyFile(path.join(stage, "best.spoken.txt"), `${output}.spoken.txt`);
        if (pieces) {
          await rm(pieces, { recursive: true, force: true });
          if (existsSync(path.join(stage, "best-pieces"))) await cp(path.join(stage, "best-pieces"), pieces, { recursive: true });
        }
        result = best.result; source = best.source;
        evidence.wordMatch = { ...best.wordMatch, keptBest: true, attempts: wordAttempts };
        if (best.pitchNote) evidence.pitchNote = best.pitchNote;
        else delete evidence.pitchNote;
        reason = undefined;
      }
      if (!reason) {
        const cacheAccepted = args.cache && !evidence.wordMatch?.keptBest;
        const cachePath = path.join(args.cacheDir, `${key}.wav`);
        if (cacheAccepted && source === "render") {
          await mkdir(args.cacheDir, { recursive: true });
          const tmp = `${cachePath}.tmp-${process.pid}`;
          await copyFile(output, tmp);
          await rename(tmp, cachePath);
        }
        await rename(output, args.output);
        await writeFile(`${args.output}.spoken.txt`, await readFile(`${output}.spoken.txt`));
        if (pieces && args.keepPiecesDir && existsSync(pieces)) await rename(pieces, args.keepPiecesDir);
        const keptPieces = args.keepPiecesDir === undefined ? undefined : source === "cache"
          ? { dir: args.keepPiecesDir, count: 0, skipped: PIECES_ON_HIT }
          : { dir: args.keepPiecesDir, count: JSON.parse(await readFile(path.join(args.keepPiecesDir, "pieces.json"), "utf8")).pieces.length };
        await writeTakeCacheReceipt(args.output, key, { cacheEnabled: cacheAccepted,
          refreshed: args.refreshCache && cacheAccepted, keptPieces, takeChecks: evidence });
        const pitchNote = evidence.pitchNote ? ` pitch=${evidence.pitchNote}` : "";
        return result.kind === "cache-hit" ? { ...result, cachePath, piecesNote: result.piecesNote + pitchNote }
          : { ...result, cacheNote: cacheAccepted ? ` cache checked->frozen key=${key}` : evidence.wordMatch?.keptBest ? " cache skipped: kept best word-mismatch take" : "",
            piecesNote: (keptPieces ? ` pieces=${keptPieces.count} kept in ${args.keepPiecesDir}` : "") + pitchNote };
      }
      if (pieces) await rm(pieces, { recursive: true, force: true });
      if (evidence.attempts >= checks.retries + 1) {
        evidence.gaveUp = true;
        throw new RunnerFailure(`take checks gave up after bounded retries: ${JSON.stringify(evidence)}`);
      }
      refresh = false;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

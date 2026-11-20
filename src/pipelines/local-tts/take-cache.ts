import { createHash } from "node:crypto";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Synth params that affect the OUTPUT bytes. The content-hash key is computed over
 * the normalized spoken text + reference identity + this param object, so any change
 * that would change the audio yields a different key (and a fresh synth), while an
 * identical request reuses the frozen accepted take. Exported for tests.
 */
export interface CacheKeyParams {
  takeChecks?: { pitchCeilingHz: number; retries: number; rejectFades?: boolean };
  eqHighshelfHz?: number;
  eqHighshelfGainDb?: number;
  loudnessTargetDb?: number;
  atempo?: number;
  sentencePauseSeconds?: number;
  commaPauseSeconds?: number;
  colonPauseSeconds?: number;
}

/**
 * The version of the code that turns a cache key's inputs into audio: how the text is
 * cut into breathing pieces and the default pauses (`src/plan/`, `./breathing.ts`), the
 * synthesis requests (`./synthesis.ts`), the ffmpeg chain (`src/audio/ffmpeg-args.ts`,
 * `src/audio/ffmpeg-run.ts`, `./loudness.ts`) and the order of the stages (`./index.ts`).
 * None of that is in the key's other inputs, so an audible change to it must
 * raise this number; otherwise every consumer keeps replaying takes frozen by the old
 * code. Raising it makes every cached take miss once, on purpose.
 * `tests/compat/take-cache-version.test.ts` fails when a recorded case's behaviour
 * changed without a raise or an attested re-record; it catches only the changes the
 * goldens record, so an audible change raises this whether it tripped or not. The
 * history lives in
 * `tests/compat/fixtures/take-cache-render-versions.json`.
 */
export const LOCAL_TTS_RENDER_VERSION: number = 5;

/**
 * The version of the take checks a frozen take passed, kept apart from the render version
 * because a checks change alters which takes are kept, not the audio for a key. Raise it
 * when a check is added or made stricter. A checked take frozen under an older (or
 * unrecorded) version is re-made on a hit when it has breathing joins, because joins can only
 * be judged while the pieces exist; a take without joins is re-judged whole on the hit.
 * 1: word, pitch and cut-ending checks (#151). 2: the cut-join check (#152).
 */
export const TAKE_CHECKS_VERSION: number = 2;

/** Read a checks version only when its digest matches the candidate bytes the caller copied. */
export async function readTakeChecksVersion(cacheDir: string, cacheKey: string,
  candidateWav = path.join(cacheDir, `${cacheKey}.wav`)): Promise<number | null> {
  try {
    const record: unknown = JSON.parse(await readFile(path.join(cacheDir, `${cacheKey}.checks.json`), "utf8"));
    if (typeof record !== "object" || record === null || !("takeChecksVersion" in record) || !("wavSha256" in record)
      || typeof record.takeChecksVersion !== "number" || !Number.isSafeInteger(record.takeChecksVersion)
      || record.takeChecksVersion < 1 || typeof record.wavSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.wavSha256)) return null;
    const digest = createHash("sha256").update(await readFile(candidateWav)).digest("hex");
    return digest === record.wavSha256 ? record.takeChecksVersion : null;
  } catch {
    return null;
  }
}

/** Stamp the exact checked candidate, after publishing the WAV; a replacement cannot inherit its checks. */
export async function writeTakeChecksVersion(cacheDir: string, cacheKey: string,
  candidateWav = path.join(cacheDir, `${cacheKey}.wav`)): Promise<void> {
  const file = path.join(cacheDir, `${cacheKey}.checks.json`);
  const temporaryPath = `${file}.tmp-${process.pid}`;
  const wavSha256 = createHash("sha256").update(await readFile(candidateWav)).digest("hex");
  await writeFile(temporaryPath, `${JSON.stringify({ takeChecksVersion: TAKE_CHECKS_VERSION, wavSha256 })}\n`, "utf8");
  await rename(temporaryPath, file);
}

/** Hash reference bytes once at the start of a render; never fall back to its path. */
export async function hashReferenceClip(referenceClip: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(referenceClip)).digest("hex");
  } catch (cause) {
    const code = cause !== null && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code : "unknown";
    throw new Error(`cannot read reference audio for take cache identity (${code})`, { cause });
  }
}

/**
 * Freeze identity uses normalized spoken text, reference audio SHA-256 + reference
 * text, profile/model and stably ordered output parameters. Paths never enter the
 * payload. Path-keyed entries miss once after this identity migration; this is not
 * an audible render change. Version 1 omits renderVersion as before, but also uses
 * content identity. Callers hash the reference once per render, including retries.
 */
export function computeContentHashKey(input: {
  spokenText: string;
  referenceAudioSha256: string;
  referenceText: string;
  profileId?: string;
  profileVersion?: string;
  model?: string;
  params: CacheKeyParams;
  renderVersion?: number;
}): string {
  if (typeof input.referenceAudioSha256 !== "string" || input.referenceAudioSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(input.referenceAudioSha256)) {
    throw new Error("referenceAudioSha256 must be a 64-character lowercase sha256 hex digest");
  }
  const renderVersion = input.renderVersion ?? LOCAL_TTS_RENDER_VERSION;
  if (!Number.isSafeInteger(renderVersion) || renderVersion < 1) {
    throw new Error(`invalid render version for take cache key: ${renderVersion}`);
  }
  // Stable, explicit param ordering — never rely on object key insertion order.
  const p = input.params;
  const orderedParams = {
    eqHighshelfHz: p.eqHighshelfHz,
    eqHighshelfGainDb: p.eqHighshelfGainDb,
    loudnessTargetDb: p.loudnessTargetDb,
    atempo: p.atempo,
    sentencePauseSeconds: p.sentencePauseSeconds,
    commaPauseSeconds: p.commaPauseSeconds,
    colonPauseSeconds: p.colonPauseSeconds,
    ...(p.takeChecks ? { takeChecks: { pitchCeilingHz: p.takeChecks.pitchCeilingHz, retries: p.takeChecks.retries,
      ...(p.takeChecks.rejectFades ? { rejectFades: true } : {}) } } : {}),
  };
  // JSON.stringify drops undefined values, so absent params don't perturb the key.
  const payload = JSON.stringify({
    spokenText: input.spokenText,
    referenceAudioSha256: input.referenceAudioSha256,
    referenceText: input.referenceText,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    model: input.model,
    params: orderedParams,
    // Version 1 is omitted so its keys match the keys written before versioning.
    ...(renderVersion === 1 ? {} : { renderVersion }),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Persist the cache decision that produced a take. The sidecar is replaced
 * atomically so downstream consumers never observe a partial receipt.
 */
export async function writeTakeCacheReceipt(
  output: string,
  cacheKey: string,
  options: {
    cacheEnabled: boolean;
    takeChecks?: TakeCheckReceipt;
    /** The take was rendered fresh under --refresh-cache and replaced the cached entry. */
    refreshed?: boolean;
    /** --keep-pieces: where the pieces went and how many; `skipped` says why none were written. */
    keptPieces?: { dir: string; count: number; skipped?: string };
  },
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
    throw new Error(`invalid cache key for take receipt: ${cacheKey}`);
  }
  const receiptPath = `${output}.cache.json`;
  const temporaryPath = `${receiptPath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPath,
    // The optional fields appear only when their switch was given, so a default receipt is unchanged.
    `${JSON.stringify({
      version: 1,
      cacheKey,
      cacheEnabled: options.cacheEnabled,
      ...(options.takeChecks ? { takeChecks: options.takeChecks } : {}),
      ...(options.refreshed ? { cacheRefreshed: true } : {}),
      ...(options.keptPieces ? { keptPieces: options.keptPieces } : {}),
    })}\n`,
    "utf8",
  );
  await rename(temporaryPath, receiptPath);
  return receiptPath;
}

/** Clear stale evidence before beginning a new attempt. Missing receipts are fine. */
export async function clearTakeCacheReceipt(output: string): Promise<void> {
  try {
    await unlink(`${output}.cache.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface TakeCheckReceipt {
  wordMatch?: {
    keptBest?: boolean;
    model: string;
    note?: "not judged: no Latin-script words";
    attempts: { source: "cache" | "render"; attempt: number; editCount: number | null }[];
    pass: boolean;
    setting: string;
    edits: { kind: string; sentIndex: number; recognisedIndex: number; start: number | null; end: number | null }[];
  };
  pitchNote?: "not judged: shorter than one window";
  /** The kept take's cut-ending measures (tail level relative to its speech level, in dB; steepest fall at the end). */
  cutEnding?: {
    failed: boolean;
    reason: "tail-at-speech-level" | "last-word-runs-to-end" | "fade-from-speech-level" | null;
    tailRelDb: number | null;
    fadeDbPer10ms: number | null;
    fadePeakRelDb: number | null;
    fadeDetected: boolean;
    audioEndSeconds: number;
    lastWordEndSeconds: number | null;
    note?: "not judged: too short or silent";
  };
  /** The kept take's breathing-piece ends before the last, each measured like `cutEnding`; cut pieces are listed. */
  cutJoins?: {
    failed: boolean;
    piecesChecked: number;
    fadeMeasurements?: { piece: number; fadeDbPer10ms: number | null; fadePeakRelDb: number | null; detected: boolean }[];
    cuts: { piece: number; of: number; text: string; reason: "tail-at-speech-level" | "last-word-runs-to-end" | "fade-from-speech-level";
      tailRelDb: number | null; fadeDbPer10ms: number | null; endSeconds: number; lastWordEndSeconds: number | null }[];
    note?: "not judged: a cache hit keeps no pieces";
  };
  /** Present only when a cache hit was frozen under older take checks, and what was done about it. */
  cachedChecks?: { recordedVersion: number | null; currentVersion: number; action: "re-made" | "re-judged" };
  attempts: number;
  failures: { source: "cache" | "render"; attempt: number; reason: string }[];
  gaveUp: boolean;
}

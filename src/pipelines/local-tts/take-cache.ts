import { createHash } from "node:crypto";
import { writeFile, rename, unlink } from "node:fs/promises";

/**
 * Synth params that affect the OUTPUT bytes. The content-hash key is computed over
 * the normalized spoken text + reference identity + this param object, so any change
 * that would change the audio yields a different key (and a fresh synth), while an
 * identical request reuses the frozen accepted take. Exported for tests.
 */
export interface CacheKeyParams {
  eqHighshelfHz?: number;
  eqHighshelfGainDb?: number;
  loudnessTargetDb?: number;
  atempo?: number;
  sentencePauseSeconds?: number;
  commaPauseSeconds?: number;
}

/**
 * The version of the code that turns a cache key's inputs into audio: how the text is
 * cut into breathing pieces, the default pauses, the ffmpeg chain and the order of the
 * stages. None of that is in the key's other inputs, so an audible change to it must
 * raise this number; otherwise every consumer keeps replaying takes frozen by the old
 * code. Raising it makes every cached take miss once, on purpose.
 * `tests/compat/take-cache-version.test.ts` fails when the runner's audible behaviour
 * changed without a raise; the history lives in
 * `tests/compat/fixtures/take-cache-render-versions.json`.
 */
export const LOCAL_TTS_RENDER_VERSION = 1;

/**
 * Compute the content-hash freeze key (sha256, hex) for a synth request. The key is
 * the determinism layer: qwen3 is non-deterministic, so freezing an accepted take by
 * its key is the canonical mechanism for reproducibility. The hash covers the LITERAL
 * normalized spoken text (what the daemon receives), the reference clip path + ref
 * text (voice identity), and the JSON of the OUTPUT-affecting synth params. Param keys
 * are serialized in a STABLE order so the key is independent of object construction
 * order; undefined params are omitted (a profile that never sets atempo hashes the same
 * with or without an explicit undefined). `renderVersion` defaults to
 * LOCAL_TTS_RENDER_VERSION; at version 1 it is left out of the hashed text, so the key is
 * byte-for-byte the key from before the version existed, and every take frozen then still
 * hits. Any other version is hashed. Exported for tests.
 */
export function computeContentHashKey(input: {
  spokenText: string;
  referenceClip: string;
  referenceText: string;
  profileId?: string;
  profileVersion?: string;
  model?: string;
  params: CacheKeyParams;
  renderVersion?: number;
}): string {
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
  };
  // JSON.stringify drops undefined values, so absent params don't perturb the key.
  const payload = JSON.stringify({
    spokenText: input.spokenText,
    referenceClip: input.referenceClip,
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
  options: { cacheEnabled: boolean },
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
    throw new Error(`invalid cache key for take receipt: ${cacheKey}`);
  }
  const receiptPath = `${output}.cache.json`;
  const temporaryPath = `${receiptPath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 1, cacheKey, cacheEnabled: options.cacheEnabled })}\n`,
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

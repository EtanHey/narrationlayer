import { normalizeReturnedTimings } from "../../timing/returned-timings";
export interface Samples { sample_count: number; sample_rate: number }
/** Nonnegative rational milliseconds; nearest integer, ties upward (half away from zero). */
export function startMs(prefix: readonly Samples[]): number {
  let numerator = 0n, denominator = 1n;
  const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
  for (const p of prefix) {
    if (!Number.isSafeInteger(p.sample_count) || p.sample_count < 0 || !Number.isSafeInteger(p.sample_rate) || p.sample_rate <= 0) throw new RangeError("invalid decoded sample count or rate");
    const rate = BigInt(p.sample_rate);
    numerator = numerator * rate + BigInt(p.sample_count) * 1000n * denominator;
    denominator *= rate;
    const divisor = gcd(numerator, denominator); numerator /= divisor; denominator /= divisor;
  }
  const result = Number((2n * numerator + denominator) / (2n * denominator));
  if (!Number.isSafeInteger(result)) throw new RangeError("audio time exceeds safe integer");
  return result;
}
/** Backend timing payload uses the existing returned-timings envelope, in piece-local seconds/ms.
 * Entire pieces fall back on any mismatch. Estimation is equal interpolation, as VL speech-words.ts:31-41 with no measured anchors. */
export function wordTimes(words: readonly { index: number; text: string }[], start_ms: number, duration_ms: number, timings: unknown) {
  const payload = timings !== null && typeof timings === "object" ? timings : {};
  const read = (key: string): unknown => key in payload ? Reflect.get(payload, key) : undefined;
  const raw = read("word_timings") ?? read("words") ?? read("word_boundaries");
  const measured = normalizeReturnedTimings({ word_timings: raw, words: undefined, word_boundaries: undefined });
  const usable = Array.isArray(raw) && raw.length === words.length && measured.length === words.length && measured.every((t, i) =>
    t.word === words[i].text && t.index === i && t.start >= 0 && t.end > t.start && t.end * 1000 <= duration_ms &&
    (i === 0 || t.start >= measured[i - 1].start && t.end >= measured[i - 1].end));
  return words.map((word, i) => ({ index: word.index,
    start_ms: start_ms + Math.round(usable ? measured[i].start * 1000 : duration_ms * i / words.length),
    end_ms: start_ms + Math.round(usable ? measured[i].end * 1000 : duration_ms * (i + 1) / words.length),
    timing: usable ? "measured" as const : "estimated" as const }));
}

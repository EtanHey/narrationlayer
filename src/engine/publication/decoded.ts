/** Frame counts are samples per channel, independent of backend metadata. */
export interface Decoded { sample_count: number; sample_rate: number; channels: number }
export class AudioDecodeError extends Error {}
/** RIFF integer/float WAV, including extensible headers: counting frames needs frame size,
 * not sample encoding. Unknown streaming sizes consume the remainder; other truncation and
 * bytes outside a declared RIFF fail closed. Only a final data chunk may omit its odd pad. */
function layout(bytes: Uint8Array) {
  const fail = (): never => { throw new AudioDecodeError("unsupported or incomplete WAV"); };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (p: number) => String.fromCharCode(...bytes.subarray(p, p + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || (v.getUint32(4, true) !== 0xFFFFFFFF && v.getUint32(4, true) + 8 !== bytes.length)) fail();
  let format: { sample_rate: number; channels: number; frame: number; bits: number; encoding: number } | undefined, data: number | undefined, dataAt = 0;
  for (let p = 12; p < bytes.length;) {
    if (p + 8 > bytes.length) fail();
    const id = tag(p), declared = v.getUint32(p + 4, true);
    if (!/^[\x20-\x7E]{4}$/.test(id)) fail();
    const size = id === "data" && declared === 0xFFFFFFFF ? bytes.length - p - 8 : declared;
    const end = p + 8 + size;
    const padding = id === "data" && end === bytes.length ? 0 : size % 2;
    if (end + padding > bytes.length) fail();
    if (tag(p) === "fmt ") {
      if (format || size < 16) fail();
      const tag = v.getUint16(p + 8, true);
      const encoding = tag === 0xFFFE && size >= 40 ? v.getUint16(p + 32, true) : tag;
      const channels = v.getUint16(p + 10, true), sample_rate = v.getUint32(p + 12, true);
      const bits = v.getUint16(p + 22, true), frame = channels * bits / 8;
      if (!channels || !sample_rate || !(encoding === 1 ? [8, 16, 24, 32] : encoding === 3 ? [32, 64] : []).includes(bits) || v.getUint16(p + 20, true) !== frame || v.getUint32(p + 16, true) !== sample_rate * frame) fail();
      format = { channels, sample_rate, frame, bits, encoding };
    } else if (tag(p) === "data") { if (data !== undefined) fail(); data = size; dataAt = p + 8; }
    p = end + padding;
  }
  if (!format || data === undefined || data % format.frame) return fail();
  return { ...format, sample_count: data / format.frame, dataAt };
}

export function decodePcm(bytes: Uint8Array): Decoded {
  const { sample_count, sample_rate, channels } = layout(bytes);
  return { sample_count, sample_rate, channels };
}
/** Full scale: unsigned 8-bit is centered at 128 and divided by 128; signed
 * integers by 2^(bits-1); IEEE float by 1. Scan frames, stopping at the first
 * channel strictly above -42 dBFS. Silence returns the rounded full duration. */
export function firstAudibleOffsetMs(bytes: Uint8Array): number {
  const f = layout(bytes), v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = f.bits / 8, threshold = 10 ** (-42 / 20);
  let frame = 0;
  scan: for (; frame < f.sample_count; frame++) for (let ch = 0; ch < f.channels; ch++) {
    const at = f.dataAt + frame * f.frame + ch * width;
    const value = f.encoding === 3 ? (f.bits === 32 ? v.getFloat32(at, true) : v.getFloat64(at, true))
      : f.bits === 8 ? (v.getUint8(at) - 128) / 128
      : f.bits === 16 ? v.getInt16(at, true) / 32768
      : f.bits === 24 ? ((v.getInt16(at + 1, true) << 8) | v.getUint8(at)) / 8388608
      : v.getInt32(at, true) / 2147483648;
    if (Math.abs(value) > threshold) break scan;
  }
  // Same nonnegative rational rounding as startMs; audio and timing stay independent.
  return Number((2n * BigInt(frame) * 1000n + BigInt(f.sample_rate)) / (2n * BigInt(f.sample_rate)));
}

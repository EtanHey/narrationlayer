/** Frame counts are samples per channel, independent of backend metadata. */
export interface Decoded { sample_count: number; sample_rate: number; channels: number }
export class AudioDecodeError extends Error {}
/** Strict RIFF PCM: truncated chunks (including data), partial frames and missing padding fail closed. */
export function decodePcm(bytes: Uint8Array): Decoded {
  const fail = (): never => { throw new AudioDecodeError("unsupported or incomplete PCM WAV"); };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (p: number) => String.fromCharCode(...bytes.subarray(p, p + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || v.getUint32(4, true) + 8 !== bytes.length) fail();
  let format: { sample_rate: number; channels: number; frame: number } | undefined, data: number | undefined;
  for (let p = 12; p < bytes.length;) {
    if (p + 8 > bytes.length) fail();
    const size = v.getUint32(p + 4, true), end = p + 8 + size;
    if (end + (size % 2) > bytes.length) fail();
    if (tag(p) === "fmt ") {
      if (format || size < 16 || v.getUint16(p + 8, true) !== 1) fail();
      const channels = v.getUint16(p + 10, true), sample_rate = v.getUint32(p + 12, true);
      const bits = v.getUint16(p + 22, true), frame = channels * bits / 8;
      if (!channels || !sample_rate || ![8, 16, 24, 32].includes(bits) || v.getUint16(p + 20, true) !== frame || v.getUint32(p + 16, true) !== sample_rate * frame) fail();
      format = { channels, sample_rate, frame };
    } else if (tag(p) === "data") { if (data !== undefined) fail(); data = size; }
    p = end + (size % 2);
  }
  if (!format || data === undefined || data % format.frame) return fail();
  return { sample_count: data / format.frame, sample_rate: format.sample_rate, channels: format.channels };
}

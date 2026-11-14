export type RecognisedWord = { word: string; start: number; end: number };

// Step-1 exact-token normalization; this screen is for Latin-script recognition.
function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function firstWordOmitted(sent: string, recognised: readonly RecognisedWord[]) {
  const first = normalize(sent.trim().split(/\s+/)[0]);
  if (!first) throw new Error("sent text needs a nonempty Latin-script first word");
  const found = recognised.some(({ word }) => normalize(word) === first);
  return { omitted: !found, recognisedCount: recognised.length };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const i = Math.floor(values.length / 2);
  return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2;
}

// YIN difference/autocorrelation estimator, 64 ms frames, 10 ms hop,
// 65–450 Hz. Aperiodic/quiet frames do not contribute to voiced medians.
export function pitchRunaway(samples: Float32Array, sampleRate: number, ceilingHz: number) {
  if (!Number.isFinite(sampleRate) || sampleRate < 2000) throw new Error("invalid sample rate");
  if (!Number.isFinite(ceilingHz) || ceilingHz <= 0) throw new Error("invalid pitch ceiling");
  const size = Math.round(sampleRate * 0.064);
  const hop = Math.round(sampleRate * 0.01);
  const lo = Math.ceil(sampleRate / 450), hi = Math.floor(sampleRate / 65);
  const buckets: number[][] = Array.from({ length: Math.ceil(samples.length / sampleRate) }, () => []);
  for (let center = 0; center < samples.length; center += hop) {
    const frame = new Float64Array(size);
    let energy = 0;
    for (let i = 0; i < size; i++) {
      const x = samples[center - Math.floor(size / 2) + i] ?? 0;
      if (!Number.isFinite(x)) throw new Error("nonfinite audio sample");
      frame[i] = x; energy += x * x;
    }
    if (energy / size < 10 ** (-45 / 10)) continue;
    const diff = new Float64Array(hi + 2);
    let sum = 0;
    for (let lag = 1; lag <= hi + 1; lag++) {
      let value = 0;
      for (let i = 0; i < size - hi - 1; i++) value += (frame[i] - frame[i + lag]) ** 2;
      sum += value;
      diff[lag] = sum ? value * lag / sum : 1;
    }
    let lag = lo;
    while (lag <= hi && diff[lag] > 0.15) lag++;
    if (lag > hi) continue;
    while (lag < hi && diff[lag + 1] < diff[lag]) lag++;
    const a = diff[lag - 1], b = diff[lag], c = diff[lag + 1];
    const offset = a + c === 2 * b ? 0 : (a - c) / (2 * (a - 2 * b + c));
    const hz = sampleRate / (lag + offset);
    if (hz >= 65 && hz <= 450) buckets[Math.floor(center / sampleRate)].push(hz);
  }
  const windows = buckets.map((values, start) => ({ start, end: Math.min(start + 1, samples.length / sampleRate), voicedFrames: values.length, medianHz: median(values) }));
  const overCeiling = windows.filter((w) => w.medianHz !== null && w.medianHz > ceilingHz);
  const voiced = windows.flatMap((w) => w.medianHz === null ? [] : [w.medianHz]);
  return { failed: overCeiling.length > 0, ceilingHz, worstMedianHz: voiced.length ? Math.max(...voiced) : null, windows, overCeiling };
}

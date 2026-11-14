export type RecognisedWord = { word: string; start: number; end: number };

// Step-1 exact-token normalization; this screen is for Latin-script recognition.
function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function numberValue(tokens: readonly string[]): number | null {
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) return Number(tokens[0]);
  let value = 0;
  for (const token of tokens) {
    const n = NUMBER_WORDS[token];
    if (n === undefined) return null;
    value += n;
  }
  return tokens.length ? value : null;
}

export function firstWordOmitted(sent: string, recognised: readonly RecognisedWord[]) {
  const sentTokens = sent.trim().split(/\s+/).map(normalize);
  while (sentTokens.length && !sentTokens[0]) sentTokens.shift();
  const first = sentTokens[0];
  if (!first) throw new Error("sent text needs a nonempty Latin-script first word");
  const tokens = recognised.map(({ word }) => normalize(word));
  while (tokens.length && !tokens[0]) tokens.shift();
  const opening = tokens.slice(0, 3);
  let found = false;
  for (let start = 0; start < opening.length; start++) {
    for (let end = start + 1; end <= opening.length; end++) {
      const candidate = opening.slice(start, end);
      if (candidate.join("") === first) found = true;
      const n = numberValue(candidate);
      if (n !== null) {
        for (let length = 1; length <= Math.min(3, sentTokens.length); length++) {
          if (numberValue(sentTokens.slice(0, length)) === n) found = true;
        }
      }
    }
  }
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
  const buckets: number[][] = Array.from({ length: Math.floor(samples.length / sampleRate) }, () => []);
  for (let center = 0; center < buckets.length * sampleRate; center += hop) {
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
    while (lag <= hi && diff[lag] > 0.2) lag++;
    if (lag > hi) continue;
    while (lag < hi && diff[lag + 1] < diff[lag]) lag++;
    const a = diff[lag - 1], b = diff[lag], c = diff[lag + 1];
    const offset = a + c === 2 * b ? 0 : (a - c) / (2 * (a - 2 * b + c));
    const hz = sampleRate / (lag + offset);
    if (hz >= 65 && hz <= 450) buckets[Math.floor(center / sampleRate)].push(hz);
  }
  const windows = buckets.map((values, start) => ({ start, end: Math.min(start + 1, samples.length / sampleRate), voicedFrames: values.length, medianHz: values.length >= 10 ? median(values) : null }));
  const overCeiling = windows.filter((w) => w.medianHz !== null && w.medianHz > ceilingHz);
  const voiced = windows.flatMap((w) => w.medianHz === null ? [] : [w.medianHz]);
  return { failed: overCeiling.length > 0, ceilingHz, worstMedianHz: voiced.length ? Math.max(...voiced) : null, windows, overCeiling };
}

import { TRANSCRIPTION_TOKEN, isTranscriptionNumberSpan, transcriptionHomophones, transcriptionNumbers, transcriptionSpelling } from "./transcription-equivalence.js";

export type RecognisedWord = { word: string; start: number; end: number };

// Step-1 exact-token normalization; this screen is for Latin-script recognition.
function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Number keys (the word check's own equivalence) of spans starting at the first `starts` tokens.
function openingNumberKeys(tokens: readonly string[], starts: number): Set<string> {
  const index = transcriptionNumbers(tokens.slice(0, starts + 12));
  // A unit-only key ("dollars") never stands in for a clipped opening number.
  return new Set(index.slice(0, starts).flatMap(spans => [...spans.keys()]).filter(key => !key.startsWith("unit:")));
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
      if (opening.slice(start, end).join("") === first) found = true;
    }
  }
  // An opening number may be heard in its other form ("Forty percent" / "40%", "$400" / "four hundred
  // dollars"); it counts only when a span starting in the first three heard words has the same value.
  const sentWords = sent.match(TRANSCRIPTION_TOKEN) ?? [];
  const sentKeys = openingNumberKeys(sentWords, sentWords[0] === "$" ? 2 : 1);
  const heardWords = recognised.map(({ word }) => word.match(TRANSCRIPTION_TOKEN) ?? []).filter(parts => parts.length);
  const heardStarts = heardWords.slice(0, 3).flat().length;
  for (const key of openingNumberKeys(heardWords.flat(), heardStarts)) if (sentKeys.has(key)) found = true;
  return { omitted: !found, recognisedCount: recognised.length };
}

export type WordCheckSetting = "a" | "b" | "c" | "d";
export type WordCheckOptions = { tolerance?: boolean; setting?: WordCheckSetting; commonWords?: ReadonlySet<string> };

export type WordEdit = {
  kind: "deletion" | "insertion" | "substitution";
  sentIndex: number;
  recognisedIndex: number;
  sent: string[];
  recognised: string[];
  // A deletion has no recognised interval; its position is the boundary before recognisedIndex.
  start: number | null;
  end: number | null;
};

const CONTRACTIONS: Record<string, string | readonly [string, ...string[]]> = {
  cant: "cannot", wont: "willnot", dont: "donot", doesnt: "doesnot",
  didnt: "didnot", isnt: "isnot", arent: "arenot", wasnt: "wasnot",
  werent: "werenot", couldnt: "couldnot", wouldnt: "wouldnot",
  shouldnt: "shouldnot", havent: "havenot", hasnt: "hasnot", hadnt: "hadnot",
  im: "iam", youre: "youare", were: "weare", theyre: "theyare", therere: "thereare",
  ive: "ihave", youve: "youhave", weve: "wehave", theyve: "theyhave",
  ill: "iwill", youll: "youwill", well: "wewill", theyll: "theywill",
  its: ["itis", "ithas"], thats: ["thatis", "thathas"], theres: ["thereis", "therehas"],
  heres: ["hereis", "herehas"], whats: ["whatis", "whathas"], wheres: ["whereis", "wherehas"],
  hows: ["howis", "howhas"], whos: ["whois", "whohas"],
  hes: ["heis", "hehas"], shes: ["sheis", "shehas"],
  hell: "hewill", shell: "shewill", itll: "itwill", thatll: "thatwill",
  therell: "therewill", wholl: "whowill",
  id: ["iwould", "ihad"], youd: ["youwould", "youhad"], hed: ["hewould", "hehad"],
  shed: ["shewould", "shehad"], itd: ["itwould", "ithad"], wed: ["wewould", "wehad"],
  theyd: ["theywould", "theyhad"], thatd: ["thatwould", "thathad"],
  thered: ["therewould", "therehad"], whod: ["whowould", "whohad"], lets: "letus",
};

function spellingDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    }
    previous = row;
  }
  return previous[b.length];
}

// Number words (and scale plurals) never take the one-letter spelling allowance:
// seventy/seventh, eighty/eighth and million/billion are different values.
function numberWord(word: string): boolean {
  const token = normalize(word);
  // normalize() drops the hyphen, so "forty-eighth" is also tested whole with its hyphen kept and a
  // trailing 's removed; part-by-part testing wrongly caught "one-liner" and "second-rate" (red team r2).
  const lower = word.toLowerCase().replace(/['’]s$/, "");
  return [token, lower, normalize(lower)].some(part =>
    isTranscriptionNumberSpan([part]) || /^(?:hundred|thousand|million|billion|trillion)(?:th)?s?$/.test(part));
}

function canonicalWords(word: string): readonly [string, ...string[]] {
  const token = normalize(word);
  // Expand only a written apostrophe: e.g. ordinary "well" must not become "we will".
  const expansion = /['’]/.test(word) ? CONTRACTIONS[token] ?? token : transcriptionSpelling(token);
  return typeof expansion === "string" ? [expansion] : expansion;
}

function canonicalSpans(words: readonly string[]): string[] {
  return words.reduce<string[]>((spans, word) =>
    spans.flatMap(span => canonicalWords(word).map(expansion => span + expansion)), [""]);
}

/** Whole-take token edit alignment. Positions are zero-based; tolerance:false keeps only case/punctuation folding. */
export function wordMismatches(sent: string, recognised: readonly RecognisedWord[], options: WordCheckOptions = {}) {
  const setting = options.setting ?? "a";
  if ((setting === "b" || setting === "c") && !options.commonWords) throw new Error("settings b/c require a common-word dictionary");
  const expected = (sent.match(TRANSCRIPTION_TOKEN) ?? []);
  const raw = recognised.flatMap((item, index) =>
    (item.word.match(TRANSCRIPTION_TOKEN) ?? []).map(word => ({ ...item, word, index })));
  if (!expected.length) throw new Error("sent text needs nonempty Latin-script words");
  const tolerant = options.tolerance !== false;
  const expectedNumbers = tolerant ? transcriptionNumbers(expected) : [];
  const heardNumbers = tolerant ? transcriptionNumbers(raw.map(w => w.word)) : [];
  type Step = { i: number; j: number; kind: WordEdit["kind"] | "match" };
  const cells: { cost: number; step: Step | null }[][] = Array.from({ length: expected.length + 1 }, () =>
    Array.from({ length: raw.length + 1 }, () => ({ cost: Infinity, step: null })));
  cells[0][0].cost = 0;
  for (let i = 0; i <= expected.length; i++) {
    for (let j = 0; j <= raw.length; j++) {
      const update = (ni: number, nj: number, cost: number, kind: Step["kind"]) => {
        if (cells[i][j].cost + cost < cells[ni][nj].cost) {
          cells[ni][nj] = { cost: cells[i][j].cost + cost, step: { i, j, kind } };
        }
      };
      for (const [key, length] of expectedNumbers[i] ?? []) {
        const heardLength = heardNumbers[j]?.get(key);
        if (heardLength !== undefined) update(i + length, j + heardLength, 0, "match");
      }
      for (let a = 1; a <= Math.min(tolerant ? 3 : 1, expected.length - i); a++) {
        for (let b = 1; b <= Math.min(tolerant ? 3 : 1, raw.length - j); b++) {
          const left = expected.slice(i, i + a), right = raw.slice(j, j + b).map(w => w.word);
          const l = left.map(w => tolerant ? canonicalWords(w)[0] : normalize(w)).join("");
          const r = right.map(w => tolerant ? canonicalWords(w)[0] : normalize(w)).join("");
          // Numbers and units must use their parsed keys, never concatenation or fuzzy spelling.
          const tokens = [...left, ...right];
          const mixedName = tokens.some(w => /[a-z]/i.test(w) && /[0-9]/.test(w));
          const numeric = tokens.some(w => /[0-9$%]/.test(w)) && !mixedName
            || tokens.some(w => /^[$%]$|^[+-]\d/.test(w))
            || (isTranscriptionNumberSpan(left) && isTranscriptionNumberSpan(right));
          let equivalent = l === r;
          if (!equivalent && tolerant && !numeric) {
            const rightSpans = canonicalSpans(right);
            equivalent = canonicalSpans(left).some(span => rightSpans.includes(span));
          }
          // A listed homophone matches one word for one word, never inside a joined compound.
          if (!equivalent && tolerant && !numeric && a === 1 && b === 1) equivalent = transcriptionHomophones(l, r);
          const match = (equivalent && (!numeric || left.join(" ").toLowerCase() === right.join(" ").toLowerCase()))
            || (tolerant && a === 1 && b === 1 && !/[0-9]/.test(left[0] + right[0])
              && ![left[0], right[0]].some(w => /['’]/.test(w) && normalize(w) in CONTRACTIONS || numberWord(w))
              && Math.min(l.length, r.length) >= 6 && spellingDistance(l, r) <= 1);
          if (match) update(i + a, j + b, 0, "match");
        }
      }
      if (i < expected.length && j < raw.length) update(i + 1, j + 1, 1, "substitution");
      if (i < expected.length) update(i + 1, j, 1, "deletion");
      if (j < raw.length) update(i, j + 1, 1, "insertion");
    }
  }
  const edits: WordEdit[] = [];
  let i = expected.length, j = raw.length;
  while (i || j) {
    const step = cells[i][j].step;
    if (!step) throw new Error("unreachable alignment cell");
    if (step.kind !== "match") {
      edits.push({ kind: step.kind, sentIndex: step.i, recognisedIndex: raw[step.j]?.index ?? recognised.length,
        sent: expected.slice(step.i, i), recognised: raw.slice(step.j, j).map(w => w.word),
        start: step.j < j ? raw[step.j].start : null, end: step.j < j ? raw[j - 1].end : null });
    }
    i = step.i; j = step.j;
  }
  const matches = [...sent.matchAll(TRANSCRIPTION_TOKEN)];
  const classified = edits.reverse().map(edit => {
    const token = edit.sent[0] ?? "", heard = edit.recognised[0] ?? "";
    const prefix = sent.slice(0, matches[edit.sentIndex]?.index ?? sent.length);
    const midSentence = edit.sentIndex > 0 && !/[.!?]\s*$/.test(prefix);
    const jargon = (options.commonWords ? !options.commonWords.has(normalize(token)) : false)
      || /[a-z][A-Z]|[0-9]/.test(token) || (midSentence && /^[A-Z]/.test(token));
    const l = normalize(token), r = normalize(heard);
    const jargonVariant = jargon && spellingDistance(l, r) / Math.max(l.length, r.length, 1) <= 0.5;
    const commonVariant = !jargon && !(l.length >= 4 && r.length >= 4 || options.commonWords?.has(r));
    const ignored = edit.kind === "substitution" && (setting === "d"
      || (setting !== "a" && jargonVariant) || (setting === "c" && commonVariant));
    return { ...edit, tokenClass: jargon ? "jargon" : "common", ignored };
  });
  const rejected = classified.filter(edit => !edit.ignored);
  return { pass: rejected.length === 0 && raw.length > 0, setting, sentCount: expected.length,
    recognisedCount: raw.length, edits: rejected, ignoredEdits: classified.filter(edit => edit.ignored) };
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

export type CutEndingOptions = {
  /** Experimental fade rejection; measurements are always reported. Default false pending more listening labels. */
  rejectFades?: boolean;
  /** Ignored stretch just before the audio end (decoder or codec fade). */
  guardSeconds?: number;
  /** Length of the measured tail window. */
  windowSeconds?: number;
  /** Tail level, relative to the take's speech level, at or above which the ending is cut. */
  maxTailRelDb?: number;
  /** Lower tail bar used when the last recognised word also runs to the audio end. */
  timedTailRelDb?: number;
  /** A tail quieter than this (dBFS) is never judged cut, whatever its relative level. */
  minTailDbfs?: number;
  /** The last word "runs to the end" when it ends at or after the audio end minus this. */
  wordEndMarginSeconds?: number;
  /** Fade cut: a fall at least this steep (dB per 10 ms, over 50 ms) in the last `fadeWindowSeconds` of sound... */
  fadeDbPer10ms?: number;
  /** ...that starts with a 10 ms frame within this many dB of the take's speech level. */
  fadePeakRelDb?: number;
  /** Stretch of sound, back from its end, in which the fade is looked for. */
  fadeWindowSeconds?: number;
  /** Trailing 5 ms frames this far under speech level are not sound: the fade is measured to the last sounding frame. */
  soundFloorRelDb?: number;
};

// Calibrated 18 Nov 2026 at 16 kHz on clean takes (all at or below -15.1 dB) against heard cut
// endings (-6.9 dB and above); real pages show a gap between -7.5 and -8.7 dB. The recogniser's
// last-word end reaches the audio end on about one clean take in five, so timing only lowers the bar.
// Fade rejection stays opt-in pending more listening labels; its level and slope must describe the same pair.
export const CUT_ENDING_DEFAULTS: Required<CutEndingOptions> = {
  rejectFades: false,
  guardSeconds: 0.01,
  windowSeconds: 0.025,
  maxTailRelDb: -8,
  timedTailRelDb: -12,
  minTailDbfs: -45,
  wordEndMarginSeconds: 0.02,
  fadeDbPer10ms: 7,
  fadePeakRelDb: -3,
  fadeWindowSeconds: 0.15,
  soundFloorRelDb: -50,
};

export type CutEndingResult = {
  failed: boolean;
  fadeDetected: boolean;
  reason: "tail-at-speech-level" | "last-word-runs-to-end" | "fade-from-speech-level" | null;
  note: "not judged: too short or silent" | null;
  durationSeconds: number;
  audioEndSeconds: number;
  lastWordEndSeconds: number | null;
  speechDbfs: number | null;
  tailDbfs: number | null;
  tailRelDb: number | null;
  /** Steepest eligible 50 ms fall, dB per 10 ms; zero if no pair starts at speech level, null when not measured. */
  fadeDbPer10ms: number | null;
  /** Starting frame of that same fall, relative to speech; null when no eligible fall was found. */
  fadePeakRelDb: number | null;
  thresholds: Required<CutEndingOptions>;
};

const SUB_LSB = 1.5 / 32768;
const meanSquareDb = (power: number) => power > 0 ? 10 * Math.log10(power) : -Infinity;

/** Steepest 50 ms fall whose own starting frame meets both level gates. */
function fadeAtEnd(samples: Float32Array, end: number, sampleRate: number, speechDbfs: number, t: Required<CutEndingOptions>) {
  const level = (from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    return Math.max(meanSquareDb(sum / (to - from)), -120) - speechDbfs;
  };
  const f5 = Math.max(1, Math.round(sampleRate * 0.005)), f10 = Math.max(1, Math.round(sampleRate * 0.01));
  let soundEnd = end;
  while (soundEnd >= f5 && level(soundEnd - f5, soundEnd) < t.soundFloorRelDb) soundEnd -= f5;
  const count = Math.round(t.fadeWindowSeconds * 100);
  if (count < 6 || soundEnd < count * f10) return null;
  // frames[0] is the last 10 ms of sound; frames[k + 5] lies 50 ms before frames[k].
  const frames = Array.from({ length: count }, (_, k) => level(soundEnd - (k + 1) * f10, soundEnd - k * f10));
  let dbPer10ms = 0;
  let peakRelDb: number | null = null;
  for (let k = 0; k + 5 < count; k++) {
    const start = frames[k + 5], slope = (start - frames[k]) / 5;
    if (start >= t.fadePeakRelDb && speechDbfs + start >= t.minTailDbfs && slope > dbPer10ms) {
      dbPer10ms = slope;
      peakRelDb = start;
    }
  }
  return { dbPer10ms, peakRelDb };
}

/**
 * Cut ending: the take stops while the last word is still sounding. A finished take decays into its
 * own quiet tail; a cut one is still at speech level in its final window. Three ways to fail:
 * the final window is within `maxTailRelDb` of the take's speech level (acoustic), or the last
 * recognised word runs to the audio end and the final window is within `timedTailRelDb` (timing),
 * or, with rejectFades explicitly enabled, the sound falls from speech level faster than `fadeDbPer10ms` (a
 * word faded out before it was finished, like "addre" for "address", which leaves a quiet tail).
 * Recognised timings alone never fail a take: the recogniser also stretches clean last words to the end.
 */
export function cutEnding(samples: Float32Array, sampleRate: number, words: readonly RecognisedWord[] = [],
  options: CutEndingOptions = {}): CutEndingResult {
  if (!Number.isFinite(sampleRate) || sampleRate < 2000) throw new Error("invalid sample rate");
  const t = { ...CUT_ENDING_DEFAULTS, ...options };
  const { rejectFades, ...numeric } = t;
  if (typeof rejectFades !== "boolean" || Object.values(numeric).some(value => !Number.isFinite(value)))
    throw new Error("invalid cut-ending option");
  const durationSeconds = samples.length / sampleRate;
  // The audio end is the first sample of the trailing sub-LSB run: digital zeros after a cut hide nothing.
  let end = samples.length;
  while (end > 0 && Math.abs(samples[end - 1]) <= SUB_LSB) end--;
  for (let i = 0; i < end; i++) if (!Number.isFinite(samples[i])) throw new Error("nonfinite audio sample");
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const powers: number[] = [];
  for (let i = 0; i + frame <= end; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j];
    powers.push(sum / frame);
  }
  const loudest = powers.length ? Math.max(...powers) : 0;
  const active = powers.filter(p => p > 0 && p >= loudest * 10 ** (-25 / 10));
  const speechDbfs = active.length ? meanSquareDb(active.reduce((a, p) => a + p, 0) / active.length) : -Infinity;
  const to = end - Math.round(sampleRate * t.guardSeconds), from = to - Math.round(sampleRate * t.windowSeconds);
  const audioEndSeconds = end / sampleRate;
  const last = words.length ? words[words.length - 1] : undefined;
  const lastWordEndSeconds = last ? last.end : null;
  const base = { durationSeconds, audioEndSeconds, lastWordEndSeconds, speechDbfs: null, tailDbfs: null, tailRelDb: null,
    fadeDbPer10ms: null, fadePeakRelDb: null, fadeDetected: false, thresholds: t };
  if (from < 0 || !Number.isFinite(speechDbfs)) return { ...base, failed: false, reason: null, note: "not judged: too short or silent" };
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  const tailDbfs = meanSquareDb(sum / (to - from));
  const tailRelDb = tailDbfs - speechDbfs;
  const audible = tailDbfs >= t.minTailDbfs;
  const runsToEnd = lastWordEndSeconds !== null && lastWordEndSeconds >= audioEndSeconds - t.wordEndMarginSeconds;
  const fade = fadeAtEnd(samples, end, sampleRate, speechDbfs, t);
  const faded = fade !== null && fade.peakRelDb !== null && fade.dbPer10ms >= t.fadeDbPer10ms;
  const reason: CutEndingResult["reason"] = audible && tailRelDb >= t.maxTailRelDb ? "tail-at-speech-level"
    : audible && runsToEnd && tailRelDb >= t.timedTailRelDb ? "last-word-runs-to-end"
    : rejectFades && faded ? "fade-from-speech-level" : null;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return { ...base, speechDbfs: round(speechDbfs), tailDbfs: round(tailDbfs), tailRelDb: round(tailRelDb),
    fadeDbPer10ms: fade ? round(fade.dbPer10ms) : null,
    fadePeakRelDb: fade && fade.peakRelDb !== null ? round(fade.peakRelDb) : null, fadeDetected: faded,
    failed: reason !== null, reason, note: null };
}

/** One breathing piece as joined: its own audio, and where it starts in the take with the pause after it. */
export type JoinedPieceAudio = { samples: Float32Array; startSeconds: number; spanSeconds: number };

/**
 * Cut joins: `cutEnding` on the end of every piece except the last (the take's own ending covers that one).
 * Each piece is its own generation, so it is judged against its own speech level with the same thresholds.
 * A recognised word belongs to the piece whose span (audio plus the pause after it) holds its start.
 */
export function cutPieceEndings(pieces: readonly JoinedPieceAudio[], sampleRate: number,
  words: readonly RecognisedWord[] = [], options: CutEndingOptions = {}): { index: number; result: CutEndingResult }[] {
  return pieces.slice(0, -1).map((piece, index) => {
    const from = piece.startSeconds, to = from + piece.spanSeconds;
    const own = words.filter(w => w.start >= from && w.start < to)
      .map(w => ({ word: w.word, start: w.start - from, end: w.end - from }));
    return { index, result: cutEnding(piece.samples, sampleRate, own, options) };
  });
}

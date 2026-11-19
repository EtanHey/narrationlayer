import { TRANSCRIPTION_TOKEN, isTranscriptionNumberSpan, isTranscriptionSymbol, transcriptionNumbers, transcriptionSpelling } from "../text/transcription-equivalence.js";

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
            || tokens.some(isTranscriptionSymbol)
            || (isTranscriptionNumberSpan(left) && isTranscriptionNumberSpan(right));
          let equivalent = l === r;
          if (!equivalent && tolerant && !numeric) {
            const rightSpans = canonicalSpans(right);
            equivalent = canonicalSpans(left).some(span => rightSpans.includes(span));
          }
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

// Explicit transcription aliases, never edit-distance or general suffix guessing.
const SPELLINGS: Readonly<Record<string, string>> = Object.fromEntries([
  ["colour", "color"], ["colours", "colors"], ["colourful", "colorful"],
  ["behaviour", "behavior"], ["behaviours", "behaviors"],
  ["catalogue", "catalog"], ["catalogues", "catalogs"],
  ["recogniser", "recognizer"], ["recognisers", "recognizers"],
  ["centre", "center"], ["centres", "centers"], ["licence", "license"], ["licences", "licenses"],
  ...["organis", "recognis", "normalis", "optimis", "summaris", "realis", "authoris", "analys"]
    .flatMap(stem => ["e", "es", "ed", "ing", "ation", "ations"].map(ending => {
      const uk = stem + ending;
      return [uk, stem.slice(0, -1) + "z" + ending];
    })),
]);

export function transcriptionSpelling(word: string): string {
  return SPELLINGS[word] ?? word;
}

// Units and signs: every currency symbol, percent, comparison and the U+2212 minus. Each is its own
// token so a number span can never silently lose one; only "$" and "%" have a parsed meaning, so
// any other symbol makes its span non-equivalent.
const SYMBOL = String.raw`\p{Sc}|[%<>≤≥±−]`;
// Exact homophones the recognizer wrote for a word said right, in takes on disk (P3.4 measure).
// A pair is listed only if it failed a measured take whose other words were right; each word has
// one pronunciation and it is the pair's. Left out on purpose: heteronyms (read/red, route/root),
// number words (two/to: #149), written apostrophes (it's/its: #146), names, right/write and
// grey/gray (#143 review rulings), and aloud/allowed ("aloud" said as "alod" is a marked slip).
export const TRANSCRIPTION_HOMOPHONES: readonly (readonly string[])[] = [
  ["cache", "cash"], ["queue", "cue"], ["queues", "cues"], ["queued", "cued"],
  ["pane", "pain"], ["panes", "pains"], ["wait", "weight"], ["waits", "weights"],
  ["brake", "break"], ["disk", "disc"], ["council", "counsel"], ["prose", "pros"],
  ["miner", "minor"], ["dialogs", "dialogues"], ["hey", "hay"],
];
const HOMOPHONE_GROUP: ReadonlyMap<string, number> = new Map(
  TRANSCRIPTION_HOMOPHONES.flatMap((group, index) => group.map(word => [word, index] as const)));

/** True when two normalized single words are different spellings of one listed sound. */
export function transcriptionHomophones(a: string, b: string): boolean {
  const group = HOMOPHONE_GROUP.get(a);
  return group !== undefined && group === HOMOPHONE_GROUP.get(b);
}

// Preserve units and signs before punctuation folding; only explicit numeric aliases may consume them.
export const TRANSCRIPTION_TOKEN = new RegExp(
  String.raw`[+\-−]\d+(?:,\d{3})*(?:\.\d+)?|${SYMBOL}|\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:st|nd|rd|th)?|[a-z0-9]+(?:['’.-][a-z0-9]+)*`,
  "giu",
);
const SYMBOL_TOKEN = new RegExp(String.raw`^(?:${SYMBOL})$|^[+\-−]\d`, "u");

/** A unit or sign token ("$", "€", "%", "<", "-5", "−5"): it must match literally, never be folded away. */
export function isTranscriptionSymbol(token: string): boolean {
  return SYMBOL_TOKEN.test(token);
}

/** The units and signs of a word, in order, with both minus forms as "-": "$400" is "$", "−5" is "-". */
export function transcriptionSymbols(word: string): string {
  return (word.match(TRANSCRIPTION_TOKEN) ?? [])
    .filter(isTranscriptionSymbol)
    .map((token) => (/^[+\-−]\d/.test(token) ? token[0] : token).replace("−", "-"))
    .join("");
}
const SMALL = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const ORDINALS = "zeroth first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth".split(" ");
const ORDINAL_TENS = "twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth".split(" ");

function underHundred(tokens: readonly string[]): number | null {
  if (tokens.length === 1) {
    const small = SMALL.indexOf(tokens[0]);
    if (small >= 0) return small;
    const tens = TENS.indexOf(tokens[0]);
    return tens < 0 ? null : (tens + 2) * 10;
  }
  if (tokens.length === 2) {
    const tens = TENS.indexOf(tokens[0]), units = SMALL.indexOf(tokens[1]);
    if (tens >= 0 && units > 0 && units < 10) return (tens + 2) * 10 + units;
  }
  return null;
}

function underThousand(tokens: readonly string[]): number | null {
  if (tokens[1] !== "hundred") return underHundred(tokens);
  const units = tokens[0] === "a" ? 1 : SMALL.indexOf(tokens[0]);
  if (units < 1 || units > 9) return null;
  if (tokens.length === 2) return units * 100;
  const rest = tokens.slice(tokens[2] === "and" ? 3 : 2);
  const tail = underHundred(rest);
  return tail !== null && tail > 0 ? units * 100 + tail : null;
}

const SCALES: Readonly<Record<string, number>> = { billion: 1e9, million: 1e6, thousand: 1e3 };
const ORDINAL_SCALES: Readonly<Record<string, string>> = { hundredth: "hundred", thousandth: "thousand", millionth: "million", billionth: "billion" };

function cardinal(tokens: readonly string[]): number | null {
  if (tokens.length === 1 && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(tokens[0])) {
    const literal = tokens[0].replaceAll(",", "");
    const n = Number(literal);
    return Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER ? n : null;
  }
  let total = 0, start = 0, previousScale = Infinity;
  for (let i = 0; i < tokens.length; i++) {
    const scale = SCALES[tokens[i]];
    if (scale === undefined) continue;
    const group = tokens.slice(start, i);
    const value = group.length === 1 && group[0] === "a" ? 1 : underThousand(group);
    if (scale >= previousScale || value === null || value === 0) return null;
    total += value * scale;
    previousScale = scale;
    start = i + 1;
  }
  if (start === tokens.length) return total;
  const tail = tokens.slice(start + (start > 0 && tokens[start] === "and" ? 1 : 0));
  const value = underThousand(tail);
  if (value !== null) return total + value;
  // Unambiguous two-part years only: nineteen ninety-nine, twenty twenty-six.
  if (start === 0 && (tokens[0] === "nineteen" || tokens[0] === "twenty")) {
    const year = underHundred(tokens.slice(1));
    if (year !== null && year >= 10) return (tokens[0] === "nineteen" ? 1900 : 2000) + year;
  }
  return null;
}

function ordinal(tokens: readonly string[]): number | null {
  const last = tokens.at(-1);
  if (!last) return null;
  if (tokens.length === 1 && /^(?:\d+|\d{1,3}(?:,\d{3})+)(st|nd|rd|th)$/.test(last)) {
    const n = Number(last.slice(0, -2).replaceAll(",", ""));
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
    return last.endsWith(suffix) && Number.isSafeInteger(n) ? n : null;
  }
  const small = ORDINALS.indexOf(last), tens = ORDINAL_TENS.indexOf(last);
  const replacement = small >= 0 ? SMALL[small] : tens >= 0 ? TENS[tens]
    : ORDINAL_SCALES[last];
  return replacement === undefined ? null : cardinal([...tokens.slice(0, -1), replacement]);
}

/** Bounded numeric phrase key; units and ordinal/cardinal identity are significant. */
function numberKey(input: readonly string[]): string | null {
  let tokens = input.flatMap(word => word.toLowerCase().split("-"));
  let unit = "";
  if (tokens[0] === "$") { unit = "dollar"; tokens = tokens.slice(1); }
  if (tokens.slice(-2).join(" ") === "per cent") tokens = [...tokens.slice(0, -2), "percent"];
  const last = tokens.at(-1);
  if (last === "dollars" || last === "dollar" || last === "%" || last === "percent") {
    const suffix = last === "%" || last === "percent" ? "percent" : "dollar";
    if (unit) return null;
    unit = suffix;
    tokens = tokens.slice(0, -1);
  }
  // A unit with no number ("dollars", "percent", "$") is not the number zero (red team, 18 Nov); it keeps
  // a unit-only key so "$" still matches a spoken "dollar" in the word check (red team round 2).
  if (!tokens.length) return unit ? `unit:${unit}` : null;
  const point = tokens.indexOf("point");
  // Decimal identity is textual: 18.10 is distinct from 18.1 (versions and dropped zeros).
  if (tokens.length === 1 && /^(?:\d+|\d{1,3}(?:,\d{3})+)\.\d+$/.test(tokens[0])) {
    const [whole, fraction] = tokens[0].replaceAll(",", "").split(".");
    return `cardinal:${whole.replace(/^0+(?=\d)/, "")}.${fraction}:${unit}`;
  }
  const n = cardinal(tokens);
  if (point > 0) {
    const whole = cardinal(tokens.slice(0, point));
    const digits = tokens.slice(point + 1).map(t => SMALL.indexOf(t));
    if (whole !== null && Number.isInteger(whole) && digits.length && `${whole}${digits.join("")}`.length <= 15 && digits.every(d => d >= 0 && d <= 9)) {
      return `cardinal:${whole}.${digits.join("")}:${unit}`;
    }
  }
  if (n !== null) return `cardinal:${n}:${unit}`;
  const o = ordinal(tokens);
  return o !== null && !unit ? `ordinal:${o}` : null;
}

/** Equivalence keys of the whole span (empty when it is not one number); two spans match when they share a key. */
export function transcriptionNumberKeys(tokens: readonly string[], options: { bareDigitsMayBeDollars?: boolean } = {}): string[] {
  const key = numberKey(tokens);
  if (key === null) return [];
  const keys = new Set([key]);
  // Whisper sometimes emits bare digits for spoken dollars (builder regression).
  // Symmetric by default: "four dollars" / bare "4" passes in either direction.
  // Require a digit literal on the other side; "$4" / spoken "four" still fails.
  // bareDigitsMayBeDollars: false keeps only the "dollars said, bare digits heard" direction.
  if (/^cardinal:[^:]+:dollar$/.test(key)) keys.add(key.replace(/:dollar$/, ":digit-dollar"));
  if (options.bareDigitsMayBeDollars !== false && tokens.length === 1 && /^\d[\d,.]*$/.test(tokens[0])) {
    keys.add(key.replace(/:$/, ":digit-dollar"));
  }
  return [...keys];
}

/** Index numeric spans once, retaining original token boundaries for edit evidence. */
export function transcriptionNumbers(tokens: readonly string[]): Map<string, number>[] {
  return tokens.map((_, start) => {
    const spans = new Map<string, number>();
    // Twelve original tokens covers ordinary compound numbers; never scan an unbounded phrase.
    for (let length = 1; length <= Math.min(12, tokens.length - start); length++) {
      for (const key of transcriptionNumberKeys(tokens.slice(start, start + length))) spans.set(key, length);
    }
    return spans;
  });
}

/** Literal matching guards numeric spans, while mixed letter-digit names keep compound matching. */
export function isTranscriptionNumberSpan(tokens: readonly string[]): boolean {
  return numberKey(tokens) !== null || tokens.every(token => /^[0-9.,+%$-]+$/.test(token) || isTranscriptionSymbol(token));
}

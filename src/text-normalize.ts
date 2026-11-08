/**
 * Speech text normalization for NarrationLayer.
 *
 * The Qwen3 TTS daemon applies NO pronunciation/normalization of its own, so any
 * fix for documented mispronunciations must be applied here, in narrationlayer,
 * before the script text is sent to the daemon.
 *
 * Two layers, applied in order:
 *   1. An explicit, data-driven TERM_MAP of acronyms/words, MOST SPECIFIC FIRST
 *      (e.g. `cmux-agents` before `cmux`, `tty-input` before `tty`).
 *   2. A few small GENERAL rules (snake_case -> spaces, dotted identifier -> "dot",
 *      `x-vs-y` -> "versus", leading `@word` -> "at word").
 *
 * Matching treats `.`, `_`, `-`, `@` as token separators so we never mangle an
 * ordinary word that merely contains a target as a substring (e.g. "category"
 * must not be touched, "Statton" must stay intact).
 */

export interface TermRule {
  /** The literal token (case-insensitive) to replace. */
  term: string;
  /** Spoken replacement. */
  spoken: string;
}

/**
 * Explicit term map. Longest / most specific patterns MUST come first so that,
 * e.g., `cmux-agents` wins over `cmux` and `tty-input` wins over `tty`.
 */
export const TERM_MAP: TermRule[] = [
  { term: "cmux-agents", spoken: "see mux agents" },
  { term: "tty-input", spoken: "T T Y input" },
  { term: "human-vs-agent", spoken: "human versus agent" },
  { term: "@-tag", spoken: "at tag" },
  { term: "pgid", spoken: "P G I D" },
  { term: "tty", spoken: "T T Y" },
  { term: "cmux", spoken: "see mux" },
  { term: "triage", spoken: "tree azh" },
  // Tech-term respellings: the daemon has no lexicon, so product/library names
  // that TTS routinely mangles are respelled phonetically here (TTS-feed only;
  // the displayed script keeps the original spelling). Word-boundaried like the
  // entries above, so substrings (e.g. "supabased", "nextjs-config") are safe.
  // `Next.js` MUST precede the general DOTTED_RULE so it isn't split into
  // "next dot js".
  { term: "Next.js", spoken: "next jay ess" },
  { term: "Supabase", spoken: "sooper base" },
  { term: "Twilio", spoken: "twi lee oh" },
  { term: "LiveKit", spoken: "live kit" },
  { term: "Postgres", spoken: "post gres" },
  { term: "OTP", spoken: "O T P" },
];

/** Characters that count as part of a token for boundary purposes. */
const TOKEN_CHAR = "A-Za-z0-9";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a case-insensitive matcher for a literal term that is bounded by
 * non-token characters (or string edges) on both sides. The leading/trailing
 * separator chars used in the term itself (`-`, `@`) are escaped literally, and
 * the boundary lookarounds key off alphanumerics so ordinary words are safe.
 */
export function buildTermRegExp(term: string): RegExp {
  return new RegExp(
    `(?<![${TOKEN_CHAR}])${escapeRegExp(term)}(?![${TOKEN_CHAR}])`,
    "gi",
  );
}

const COMPILED_TERMS: { regexp: RegExp; spoken: string }[] = TERM_MAP.map(
  (rule) => ({ regexp: buildTermRegExp(rule.term), spoken: rule.spoken }),
);

// General rules.

// `at @word` -> `at word`, preserving the already-spoken preposition.
const AT_PREPOSITION_RULE =
  /(?<![A-Za-z0-9])(\bat)\s+@([A-Za-z][A-Za-z0-9]*)/gi;

// `at @-tag` -> `at tag`, preserving the already-spoken preposition.
const AT_TAG_PREPOSITION_RULE =
  /(?<![A-Za-z0-9])(\bat)\s+@-tag(?![A-Za-z0-9])/gi;

// `x-vs-y` -> `x versus y` (generic). Operates on alphanumeric word halves.
const VS_RULE =
  /(?<![A-Za-z0-9])([A-Za-z0-9]+)-vs-([A-Za-z0-9]+)(?![A-Za-z0-9])/gi;

// Dotted lowercase identifier `a.b.c` -> `a dot b dot c`. Requires at least one
// dot joining two-or-more lowercase/digit segments, bounded by non-token chars.
// Avoids touching sentence-final words because it needs a segment AFTER each dot.
const DOTTED_RULE =
  /(?<![A-Za-z0-9.])([a-z0-9]+(?:\.[a-z0-9]+)+)(?![A-Za-z0-9])/g;

// snake_case `a_b` -> `a b`. Bounded; requires an underscore between segments.
const SNAKE_RULE =
  /(?<![A-Za-z0-9_])([A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)(?![A-Za-z0-9_])/g;

// Leading `@word` -> `at word`. The `@` must NOT be preceded by a token char,
// so emails like `user@example` are left alone.
const AT_RULE = /(?<![A-Za-z0-9@])@([A-Za-z][A-Za-z0-9]*)/g;

interface SpeechAliasToken {
  word: string;
  comparable: string;
}

function speechAliasTokens(text: string): SpeechAliasToken[] {
  return (String(text).match(/[\p{L}\p{N}]+(?:[._'’@-][\p{L}\p{N}]+)*/gu) ?? [])
    .map((word) => ({
      word,
      comparable: word.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, ""),
    }))
    .filter((token) => token.comparable);
}

/**
 * Derive only the lexical spans changed by deterministic speech preprocessing.
 * These aliases let STT timing stay anchored to the actual synth transcript
 * while display words keep the original authored tokens.
 */
export function deriveSpeechAliases(displayText: string, synthInput: string): TermRule[] {
  const display = speechAliasTokens(displayText);
  const synth = speechAliasTokens(synthInput);
  const lengths = Array.from({ length: display.length + 1 }, () =>
    new Array<number>(synth.length + 1).fill(0),
  );
  for (let displayIndex = display.length - 1; displayIndex >= 0; displayIndex -= 1) {
    for (let synthIndex = synth.length - 1; synthIndex >= 0; synthIndex -= 1) {
      lengths[displayIndex][synthIndex] =
        display[displayIndex].comparable === synth[synthIndex].comparable
          ? 1 + lengths[displayIndex + 1][synthIndex + 1]
          : Math.max(lengths[displayIndex + 1][synthIndex], lengths[displayIndex][synthIndex + 1]);
    }
  }

  const aliases = new Map<string, TermRule>();
  const addAlias = (term: string, spoken: string) => {
    const displayKey = term.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
    const spokenKey = spoken.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
    if (!displayKey || !spokenKey || /^\d$/.test(displayKey) || /\s/.test(term)) return;
    aliases.set(`${displayKey}\u0000${spokenKey}`, { term, spoken });
  };
  let displayIndex = 0;
  let synthIndex = 0;
  let displayGap: SpeechAliasToken[] = [];
  let synthGap: SpeechAliasToken[] = [];
  const flushGap = () => {
    if (displayGap.length === 1 && synthGap.length) {
      const term = displayGap.map((token) => token.word).join(" ");
      const spoken = synthGap.map((token) => token.word).join(" ");
      addAlias(term, spoken);
    }
    displayGap = [];
    synthGap = [];
  };

  while (displayIndex < display.length && synthIndex < synth.length) {
    if (display[displayIndex].comparable === synth[synthIndex].comparable) {
      flushGap();
      displayIndex += 1;
      synthIndex += 1;
    } else if (lengths[displayIndex + 1][synthIndex] >= lengths[displayIndex][synthIndex + 1]) {
      displayGap.push(display[displayIndex]);
      displayIndex += 1;
    } else {
      synthGap.push(synth[synthIndex]);
      synthIndex += 1;
    }
  }
  displayGap.push(...display.slice(displayIndex));
  synthGap.push(...synth.slice(synthIndex));
  flushGap();
  mapProse(displayText, prose => {
    for (const term of prose.match(/\S+/g) ?? []) {
      const spoken = normalizeSpokenRules(term);
      if (spoken !== term && synthInput.includes(spoken)) addAlias(term, spoken);
    }
    return prose;
  });
  return [...aliases.values()].sort((left, right) => right.term.length - left.term.length);
}

function normalizeLegacy(text: string, configuredRules: TermRule[]): string {
  if (!text) {
    return text;
  }

  let result = text;
  const rules = [...configuredRules].filter(rule => rule.term && rule.spoken).sort((a, b) => b.term.length - a.term.length);
  if (rules.length) {
    const byTerm = new Map(rules.map(rule => [rule.term.toLocaleLowerCase("en-US"), rule.spoken]));
    const pattern = new RegExp(`(?<![${TOKEN_CHAR}])(?:${rules.map(rule => escapeRegExp(rule.term)).join("|")})(?![${TOKEN_CHAR}])`, "gi");
    result = result.replace(pattern, match => byTerm.get(match.toLocaleLowerCase("en-US")) ?? match);
  }

  result = result.replace(
    AT_TAG_PREPOSITION_RULE,
    (_match, preposition: string) => `${preposition} tag`,
  );
  result = result.replace(
    AT_PREPOSITION_RULE,
    (_match, preposition: string, word: string) => `${preposition} ${word}`,
  );

  // 1. Explicit terms, most specific first.
  for (const { regexp, spoken } of COMPILED_TERMS) {
    result = result.replace(regexp, spoken);
  }

  // 2. General rules.
  result = result.replace(
    VS_RULE,
    (_match, left: string, right: string) => `${left} versus ${right}`,
  );
  result = result.replace(DOTTED_RULE, (match) =>
    match.split(".").join(" dot "),
  );
  result = result.replace(SNAKE_RULE, (match) => match.split("_").join(" "));
  result = result.replace(AT_RULE, (_match, word: string) => `at ${word}`);

  return result;
}

const SMALL = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "zero ten twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

function cardinal(value: string | number): string {
  const n = Number(value);
  if (n < 20) return SMALL[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${SMALL[n % 10]}` : "");
  if (n < 1000) return `${SMALL[Math.floor(n / 100)]} hundred${n % 100 ? ` ${cardinal(n % 100)}` : ""}`;
  return `${cardinal(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${cardinal(n % 1000)}` : ""}`;
}

function referenceNumber(value: string): string {
  if (value.startsWith("0")) return [...value].map(digit => SMALL[Number(digit)]).join(" ");
  const n = Number(value);
  if (n >= 100 && n < 1000 && n % 100) return `${SMALL[Math.floor(n / 100)]} ${n % 100 < 10 ? "oh " : ""}${cardinal(n % 100)}`;
  return cardinal(n);
}

function clock(hour: string | number, minute: string | undefined, period: string): string {
  const minutes = Number(minute || 0);
  return `${cardinal(hour)}${minutes ? ` ${minutes < 10 ? "oh " : ""}${cardinal(minutes)}` : ""} ${period} m`;
}

const PROTECTED = /(`+)[\s\S]*?\1(?!`)|(~{3,})[\s\S]*?\2|https?:\/\/[^\s<>`]+/gi;
function mapProse(text: string, transform: (prose: string) => string): string {
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(PROTECTED)) {
    output += transform(text.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  return output + transform(text.slice(cursor));
}

const SPOKEN_RULES: Array<[RegExp, (...args: string[]) => string]> = [
  [/(?<![\w:.])((?:1[0-2]|0?[1-9])(?::[0-5]\d)?[ \t]*[ap](?:\.m\.?|m)(?!\w)(?:-[ \t]*(?:1[0-2]|0?[1-9])(?::[0-5]\d)?[ \t]*[ap](?:\.m\.?|m)(?!\w))*)(-\w+)?/gi,
    (match, times, suffix) => suffix ? match : times.replace(/(1[0-2]|0?[1-9])(?::([0-5]\d))?[ \t]*([ap])(?:\.m\.?|m)/gi, (_: string, h: string, m: string, p: string) => clock(h, m, p.toLowerCase()))],
  [/\b(at|by|until|from)([ \t]+)([01]\d|2[0-3]):([0-5]\d)(?![\w:]|-\w|[ \t]*[ap]\.?m)/gi, (_, prefix, space, h, m) => `${prefix}${space}${clock(Number(h) % 12 || 12, m, Number(h) < 12 ? "a" : "p")}`],
  [/(?<![\w#])(?:PR|pull[ \t]+request)[ \t]+#?(\d{1,6})(?![\w/]|-\d|[ \t]*[+&,][ \t]*#\d)/gi, (_, n) => `pull request ${referenceNumber(n)}`],
  [/\be\.g\./gi, () => "for example"], [/\bi\.e\./gi, () => "that is"],
  [/(?<![\w-])vs\b\.?(?!-)/g, () => "versus"], [/\bapprox\./gi, () => "approximately"],
  [/(?<![\w:])~(\d{1,6})(?:(?:\.(\d+))?(%)|(?![\w:/–—%-]|\.\d))/g, (_, n, fraction, percent) => `about ${cardinal(n)}${fraction ? ` point ${[...fraction].map(d => SMALL[Number(d)]).join(" ")}` : ""}${percent ? " percent" : ""}`],
  [/(?<![\w.])(\d{1,6})(?:\.(\d+))?%/g, (_, n, fraction) => `${cardinal(n)}${fraction ? ` point ${[...fraction].map(d => SMALL[Number(d)]).join(" ")}` : ""} percent`],
  [/(\p{L}|\p{N})?%/gu, (_, preceding) => preceding ? `${preceding} percent` : "percent"],
  [/(?<![\w.:–—-])(?<!\|[ \t])(\d{1,6})(?:\.(\d+))?x(?![\w:–—-]|\s+(?:high|max|medium|low)\b)/gi, (_, n, fraction) => `${cardinal(n)}${fraction ? ` point ${[...fraction].map(d => SMALL[Number(d)]).join(" ")}` : ""} times`],
  [/(?<![\w./-])v(\d{1,6}(?:\.\d{1,6})+)(?![\w/-]|\.\d)/gi, (_, version) => `version ${version.split(".").map(cardinal).join(" point ")}`],
];

function normalizeSpokenRules(text: string): string {
  return SPOKEN_RULES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

export function normalizeForSpeech(text: string, pronunciationRules: TermRule[] = []): string {
  return normalizeLegacy(mapProse(text, normalizeSpokenRules), pronunciationRules);
}

export interface SpeechChannels { displayText: string; synthInput: string }

export function prepareSpeechChannels(displayText: string, pronunciationRules: TermRule[] = []): SpeechChannels {
  return { displayText, synthInput: normalizeForSpeech(displayText, pronunciationRules) };
}

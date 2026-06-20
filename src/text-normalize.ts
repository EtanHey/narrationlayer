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

interface TermRule {
  /** The literal token (case-insensitive) to replace. */
  term: string;
  /** Spoken replacement. */
  spoken: string;
}

/**
 * Explicit term map. Longest / most specific patterns MUST come first so that,
 * e.g., `cmux-agents` wins over `cmux` and `tty-input` wins over `tty`.
 */
const TERM_MAP: TermRule[] = [
  { term: "cmux-agents", spoken: "see mux agents" },
  { term: "tty-input", spoken: "T T Y input" },
  { term: "human-vs-agent", spoken: "human versus agent" },
  { term: "@-tag", spoken: "at tag" },
  { term: "pgid", spoken: "P G I D" },
  { term: "tty", spoken: "T T Y" },
  { term: "cmux", spoken: "see mux" },
  { term: "triage", spoken: "tree azh" },
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
function buildTermRegExp(term: string): RegExp {
  return new RegExp(
    `(?<![${TOKEN_CHAR}])${escapeRegExp(term)}(?![${TOKEN_CHAR}])`,
    "gi",
  );
}

const COMPILED_TERMS: { regexp: RegExp; spoken: string }[] = TERM_MAP.map(
  (rule) => ({ regexp: buildTermRegExp(rule.term), spoken: rule.spoken }),
);

// General rules.

// `x-vs-y` -> `x versus y` (generic). Operates on alphanumeric word halves.
const VS_RULE =
  /(?<![A-Za-z0-9])([A-Za-z0-9]+)-vs-([A-Za-z0-9]+)(?![A-Za-z0-9])/gi;

// Dotted lowercase identifier `a.b.c` -> `a dot b dot c`. Requires at least one
// dot joining two-or-more lowercase/digit segments, bounded by non-token chars.
// Avoids touching sentence-final words because it needs a segment AFTER each dot.
const DOTTED_RULE =
  /(?<![A-Za-z0-9.])([a-z0-9]+(?:\.[a-z0-9]+)+)(?![A-Za-z0-9.])/g;

// snake_case `a_b` -> `a b`. Bounded; requires an underscore between segments.
const SNAKE_RULE =
  /(?<![A-Za-z0-9_])([A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)(?![A-Za-z0-9_])/g;

// Leading `@word` -> `at word`. The `@` must NOT be preceded by a token char,
// so emails like `user@example` are left alone.
const AT_RULE = /(?<![A-Za-z0-9@])@([A-Za-z][A-Za-z0-9]*)/g;

export function normalizeForSpeech(text: string): string {
  if (!text) {
    return text;
  }

  let result = text;

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

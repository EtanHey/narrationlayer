/** Default colon pad for the local runner when breathing is enabled. */
export const DEFAULT_COLON_PAUSE_SECONDS = 0.35;

/**
 * Longest piece, in words, the runner sends as one generation. The Qwen3-TTS clone path
 * stops long generations at about 10 s, often mid-word; 24 words is about 7 s of speech.
 */
export const MAX_BREATHING_PIECE_WORDS = 24;
/** Fewest words either side of a split made by `splitLongPieces`. */
const MIN_SPLIT_SIDE_WORDS = 5;
const CLAUSE_END = /[,;:—–]$/;
const CONJUNCTION = new Set(["and", "but", "or", "so", "because", "while", "which", "when", "where", "though", "although", "then"]);

/**
 * Split every piece longer than `maxWords` words into pieces of at most `maxWords` words,
 * so no single generation runs into the model's length wall. Each cut is the one nearest
 * the middle that leaves at least five words on each side, preferring, in order: after a
 * clause mark (, ; : or a dash), before a conjunction, then any word gap. Pieces made by a
 * split are followed by `pauseSeconds`; the last keeps the original piece's pause.
 */
export function splitLongPieces(
  pieces: ReadonlyArray<{ text: string; padAfterSeconds: number }>,
  pauseSeconds: number,
  maxWords = MAX_BREATHING_PIECE_WORDS,
): Array<{ text: string; padAfterSeconds: number }> {
  if (!Number.isInteger(maxWords) || maxWords < 2 * MIN_SPLIT_SIDE_WORDS)
    throw new RangeError(`maxWords must be an integer of at least ${2 * MIN_SPLIT_SIDE_WORDS}`);
  return pieces.flatMap((piece) => {
    const words = [...piece.text.matchAll(/\S+/g)].map((m) => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
    if (words.length <= maxWords) return [{ ...piece }];
    // Each part is a slice of the original text, so whitespace inside a part is kept.
    const parts = splitWords(words, maxWords);
    return parts.map((part, i) => ({
      text: piece.text.slice(part[0]!.start, part.at(-1)!.end),
      padAfterSeconds: i === parts.length - 1 ? piece.padAfterSeconds : pauseSeconds,
    }));
  });
}

type Word = { word: string; start: number; end: number };

function splitWords(words: Word[], maxWords: number): Word[][] {
  if (words.length <= maxWords) return [words];
  // `cut` is the number of words kept on the left.
  const rank = (cut: number) =>
    CLAUSE_END.test(words[cut - 1]!.word) ? 0 : CONJUNCTION.has(words[cut]!.word.toLowerCase()) ? 1 : 2;
  let best = 0;
  for (let cut = MIN_SPLIT_SIDE_WORDS; cut <= words.length - MIN_SPLIT_SIDE_WORDS; cut += 1) {
    if (best === 0) { best = cut; continue; }
    const better = rank(cut) - rank(best) || Math.abs(2 * cut - words.length) - Math.abs(2 * best - words.length);
    if (better < 0) best = cut;
  }
  return [...splitWords(words.slice(0, best), maxWords), ...splitWords(words.slice(best), maxWords)];
}

/**
 * Split normalized speech text into pieces on sentence-ending punctuation (. ? !)
 * and long pauses (em-dash / semicolon / colon), tagging each piece with the pause
 * (seconds) that should FOLLOW it. Sentence-enders => sentencePad; comma/clause
 * separators (, ; —) => commaPad; a colon followed by whitespace => colonPad. The final piece carries no trailing pad (0).
 * Exported for tests. A piece with no detectable terminator keeps the text intact.
 */
export function splitForBreathing(
  text: string,
  sentencePad: number,
  commaPad: number,
  colonPad = DEFAULT_COLON_PAUSE_SECONDS,
): Array<{ text: string; padAfterSeconds: number }> {
  const pieces: Array<{ text: string; padAfterSeconds: number }> = [];
  const sentenceEnders = new Set([".", "?", "!"]);
  const clauseEnders = new Set([";", "—", ","]);
  const closingAfterSentence = new Set([
    '"',
    "'",
    "”",
    "’",
    ")",
    "]",
    "}",
    "»",
  ]);
  let pieceStart = 0;

  const pushPiece = (
    spokenEnd: number,
    nextStart: number,
    padAfterSeconds: number,
  ) => {
    const spoken = text.slice(pieceStart, spokenEnd).trim();
    if (spoken) {
      pieces.push({ text: spoken, padAfterSeconds });
    }
    pieceStart = nextStart;
    while (pieceStart < text.length && /\s/.test(text[pieceStart])) {
      pieceStart += 1;
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (sentenceEnders.has(ch)) {
      let end = i + 1;
      while (end < text.length && sentenceEnders.has(text[end])) {
        end += 1;
      }
      while (end < text.length && closingAfterSentence.has(text[end])) {
        end += 1;
      }
      if (end === text.length || /\s/.test(text[end])) {
        pushPiece(end, end, sentencePad);
        i = pieceStart - 1;
      }
      continue;
    }

    if (ch === ":" && colonPad > 0 && i + 1 < text.length && /\s/.test(text[i + 1])) {
      pushPiece(i, i + 1, colonPad);
      i = pieceStart - 1;
      continue;
    }

    if (commaPad > 0 && clauseEnders.has(ch)) {
      const end = i + 1;
      if (end === text.length || /\s/.test(text[end])) {
        pushPiece(i, end, commaPad);
        i = pieceStart - 1;
      }
    }
  }

  const tail = text.slice(pieceStart).trim();
  if (tail) pieces.push({ text: tail, padAfterSeconds: 0 });

  if (pieces.length > 0) {
    // The last piece ends the utterance — no trailing breath needed.
    pieces[pieces.length - 1].padAfterSeconds = 0;
  } else if (text.trim()) {
    pieces.push({ text: text.trim(), padAfterSeconds: 0 });
  }
  return pieces;
}

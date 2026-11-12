/**
 * Split normalized speech text into pieces on sentence-ending punctuation (. ? !)
 * and long pauses (em-dash / semicolon / colon), tagging each piece with the pause
 * (seconds) that should FOLLOW it. Sentence-enders => sentencePad; comma/clause
 * separators (, ; : —) => commaPad. The final piece carries no trailing pad (0).
 * Exported for tests. A piece with no detectable terminator keeps the text intact.
 */
export function splitForBreathing(
  text: string,
  sentencePad: number,
  commaPad: number,
): Array<{ text: string; padAfterSeconds: number }> {
  const pieces: Array<{ text: string; padAfterSeconds: number }> = [];
  const sentenceEnders = new Set([".", "?", "!"]);
  const clauseEnders = new Set([";", ":", "—", ","]);
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

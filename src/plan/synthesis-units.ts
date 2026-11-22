/** Caller-projected spoken text: one heading, whole list item, or paragraph sentence. */
export interface SynthesisSourceUnit {
  kind: "heading" | "list_item" | "sentence";
  text: string;
  pause_after_ms: number;
}

export interface SynthesisSegment extends SynthesisSourceUnit {
  source_units: number[];
  pause_in: "this_piece_end" | "next_piece_start";
  over_cap: boolean;
}

/** One request per playback piece; grouping is deliberately deferred. */
export interface SynthesisPiece {
  segments: [SynthesisSegment];
}

// §6.1 rule 2 (contract line 371), PLAN-D5: the minimum is three words.
const MIN_SYNTHESIS_WORDS = 3;
const wordCount = (text: string): number => {
  let count = 0;
  for (const token of text.matchAll(/\S+/gu)) {
    if (/[\p{L}\p{N}]/u.test(token[0]) && ++count >= MIN_SYNTHESIS_WORDS) break;
  }
  return count;
};

function splitSentence(text: string, max_chars: number): string[] {
  const parts: { start: number; end: number; words: number }[] = [];
  // Every candidate ends at a token boundary. Only the last three word starts
  // are needed to decide whether the suffix still contains the minimum.
  const lastWords: number[] = [];
  for (const token of text.matchAll(/\S+/gu)) {
    if (/[\p{L}\p{N}]/u.test(token[0])) {
      lastWords.push(token.index);
      if (lastWords.length > MIN_SYNTHESIS_WORDS) lastWords.shift();
    }
  }
  const suffixLimit = lastWords.length === MIN_SYNTHESIS_WORDS ? lastWords[0] : -1;
  let start = 0;
  while (text.length - start > max_chars) {
    // Include one lookahead character so a mark at the cap sees real whitespace.
    const window = text.slice(start, start + max_chars + 1);
    const marks = [...window.matchAll(/(?:[,;:—―–]|(?<!\S)-)(?=\s|$)/gu)]
      .map(mark => mark.index + 1).filter(end => end <= max_chars);
    const spaces = [...window.matchAll(/ /gu)]
      .map(mark => mark.index).filter(end => end > 0 && end <= max_chars);
    let cut = marks.at(-1) ?? spaces.at(-1);
    if (cut === undefined) {
      cut = text.indexOf(" ", start + max_chars) - start;
      if (cut < 0) break;
    }
    let prefixLimit = Infinity;
    let words = 0;
    for (const token of window.matchAll(/\S+/gu)) {
      if (/[\p{L}\p{N}]/u.test(token[0]) && ++words >= MIN_SYNTHESIS_WORDS) {
        prefixLimit = token.index + token[0].length;
        break;
      }
    }
    const keepsMinimum = (end: number) => end >= prefixLimit && start + end <= suffixLimit;
    if (!keepsMinimum(cut)) {
      cut = [...marks.reverse(), ...spaces.reverse()].find(keepsMinimum) ?? cut;
    }
    parts.push({ start, end: start + cut, words: wordCount(text.slice(start, start + cut)) });
    start += cut;
    if (text[start] === " ") start += 1;
  }
  parts.push({ start, end: text.length, words: wordCount(text.slice(start)) });
  // Merge short fragments without shifting the remaining array or rescanning
  // an ever-growing first fragment. Cuts separate tokens, so counts add.
  const merged: typeof parts = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (previous && (part.words < MIN_SYNTHESIS_WORDS || previous.words < MIN_SYNTHESIS_WORDS)) {
      previous.end = part.end;
      previous.words += part.words;
    } else {
      merged.push(part);
    }
  }
  return merged.map(part => text.slice(part.start, part.end).trim());
}

/**
 * Pure contract §6.1 planner. Input is already projected and segmented, not Markdown.
 * max_chars bounds sentence cuts; whole headings/items, words and minimum-word merges
 * may exceed it (over_cap reports this unresolved contract precedence).
 * The caller supplies authored pauses, including zero at the final unit.
 */
export function planSynthesisUnits({
  units, max_chars, first_piece_raw = false,
}: {
  units: readonly SynthesisSourceUnit[];
  max_chars: number;
  first_piece_raw?: boolean;
}): SynthesisPiece[] {
  if (!Number.isSafeInteger(max_chars) || max_chars < 1) {
    throw new RangeError("max_chars must be a positive safe integer");
  }
  const pieces: SynthesisPiece[] = [];
  units.forEach((unit, sourceIndex) => {
    const text = unit.text.trim().replace(/\s+/gu, " ");
    if (!text || !Number.isFinite(unit.pause_after_ms) || unit.pause_after_ms < 0) {
      throw new RangeError("source units need spoken text and a nonnegative finite pause");
    }
    // §6.1: sentences, headings and whole items are units; labels/code/links do not create units.
    const requests = unit.kind === "sentence" ? splitSentence(text, max_chars) : [text];
    requests.forEach((request, index) => {
      pieces.push({ segments: [{
        kind: unit.kind, text: request, source_units: [sourceIndex],
        over_cap: request.length > max_chars,
        // §6.1 rule 1, PLAN-02: an internal sentence cut adds no pause.
        pause_after_ms: index === requests.length - 1 ? unit.pause_after_ms : 0,
        // §1.2, PAUSE-PL-01: only raw piece 0 moves its pause into piece 1.
        pause_in: first_piece_raw && pieces.length === 0 ? "next_piece_start" : "this_piece_end",
      }] });
    });
  });
  if (first_piece_raw && pieces.length === 1 && pieces[0].segments[0].pause_after_ms > 0) {
    throw new RangeError("raw piece 0 needs piece 1 to hold its pause");
  }
  return pieces;
}

/** Caller-projected spoken text: one heading, whole list item, or paragraph sentence. */
export interface SynthesisSourceUnit {
  kind: "heading" | "list_item" | "sentence";
  text: string;
  pause_after_ms: number;
}

export interface SynthesisSegment extends SynthesisSourceUnit {
  source_units: number[];
  pause_in: "this_piece_end" | "next_piece_start";
}

/** One request per playback piece; grouping is deliberately deferred. */
export interface SynthesisPiece {
  segments: [SynthesisSegment];
}

// §6.1 rule 2 (contract line 371), PLAN-D5: the minimum is three words.
const MIN_SYNTHESIS_WORDS = 3;
const wordCount = (text: string): number => text.split(/\s+/u).filter(Boolean).length;

function splitSentence(text: string, max_chars: number): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > max_chars) {
    // §6.1 rule 1, PLAN-D4: use the last fitting phrase mark, including a later mark after a colon.
    const marks = [...remaining.matchAll(/[,;:—–-](?=\s|$)/gu)]
      .filter(mark => mark.index + 1 <= max_chars);
    let cut = marks.at(-1)?.index;
    if (cut !== undefined) {
      cut += 1;
    } else {
      // §6.1 rule 1: only a punctuation-free run may use its last fitting space.
      cut = remaining.lastIndexOf(" ", max_chars);
      // An indivisible word can exceed the cap; never cut through a word.
      if (cut <= 0) cut = remaining.indexOf(" ", max_chars);
      if (cut < 0) break;
    }
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  parts.push(remaining);
  // §6.1 rule 2, PLAN-D5: short fragments and remainders join their neighbour, even over the cap.
  for (let i = 0; i < parts.length && parts.length > 1;) {
    if (wordCount(parts[i]) >= MIN_SYNTHESIS_WORDS) {
      i += 1;
    } else if (i === 0) {
      parts.splice(0, 2, `${parts[0]} ${parts[1]}`);
    } else {
      parts.splice(i - 1, 2, `${parts[i - 1]} ${parts[i]}`);
      i -= 1;
    }
  }
  return parts;
}

/**
 * Pure contract §6.1 planner. Input is already projected and segmented, not Markdown.
 * max_chars bounds sentence cuts; whole headings/items, words and minimum-word merges
 * may exceed it. The caller supplies authored pauses, including zero at the final unit.
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

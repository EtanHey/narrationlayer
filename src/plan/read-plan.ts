import { json } from "../engine/messages/schema";
import type { Limits, Message } from "../engine/messages/messages";
import { displayTokens } from "../text/voicelayer/display-tokens";
import { structuredReadDisplay } from "../text/voicelayer/structured-display";
import { projectStructuredSpeech, type StructuredSpeech } from "../text/voicelayer/structured-speech";
import { planSynthesisUnits, type SynthesisSourceUnit } from "./synthesis-units";

type Plan = Omit<Message<"plan">, "protocol" | "owner_epoch" | "seq">;
export class ReadPlanError extends Error {
  constructor(readonly code: "EMPTY_INPUT" | "DISPLAY_UNAVAILABLE" | "TOKEN_MISMATCH") {
    super(code);
    this.name = "ReadPlanError";
  }
}

// Plain input bypasses Markdown in VL socket-handlers.ts:308-314. Identity ranges
// let the same display builder decorate it without interpreting literal markup.
function plainProjection(text: string): StructuredSpeech {
  const span = { start: 0, end: text.length };
  return { displayText: text, speechText: text,
    blocks: [{ kind: "paragraph", source: { ...span }, display: { ...span } }],
    ranges: [{ kind: "identity", source: { ...span }, display: { ...span }, speech: { ...span } }] };
}

function sourceUnits(projection: StructuredSpeech): SynthesisSourceUnit[] {
  const units: SynthesisSourceUnit[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  // Use projection blocks, not the display builder's budget-dependent runs.
  for (const block of projection.blocks) {
    const ranges = projection.ranges.filter(range => range.source.end > block.source.start
      && range.source.start < block.source.end && range.speech.end > range.speech.start
      && range.kind !== "insertion");
    if (!ranges.length) continue;
    const text = projection.speechText.slice(ranges[0].speech.start, ranges.at(-1)!.speech.end);
    const raw = projection.displayText.slice(block.source.start, block.source.end);
    if (block.kind === "heading") {
      // VL prosody.ts:202-203: h1=900, h2/h3=750, other headings=800.
      const level = raw.match(/^\s{0,3}(#{1,6})\s/)?.[1].length
        ?? (/\n\s{0,3}=+\s*$/.test(raw) ? 1 : 2);
      units.push({ kind: "heading", text, pause_after_ms: level === 1 ? 900 : level <= 3 ? 750 : 800 });
    } else if (block.kind === "list-item") {
      // VL prosody.ts:207-225 counts source words after the marker; >=6 is long.
      const body = raw.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "");
      const count = body.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
      units.push({ kind: "list_item", text, pause_after_ms: count >= 6 ? 700 : 450 });
    } else {
      // VL prosody.ts:229-252 treats code/table as prose. Sentence segmentation
      // flattens CR/LF without changing UTF-16 offsets (:284-288).
      const sentences = [...segmenter.segment(text.replace(/[\r\n]/g, " "))];
      sentences.forEach((sentence, index) => units.push({ kind: "sentence",
        text: text.slice(sentence.index, sentence.index + sentence.segment.length),
        pause_after_ms: index === sentences.length - 1 ? 1000 : 550 }));
    }
  }
  if (units.length) units[units.length - 1].pause_after_ms = 0; // VL prosody.ts:398
  return units;
}

/** Pure request-to-plan projection; engine selection and pronunciation belong to callers/later slices. */
export function planRead({ request, limits, identity, engine, first_piece_raw = false }: {
  request: Message<"narrate">;
  limits: Limits;
  identity: Pick<Message<"plan">, "session_id" | "attempt_id">;
  engine: Plan["engine"];
  first_piece_raw?: boolean;
}): { plan: Plan; requests: readonly { piece_index: number; text: string }[] } {
  const projection = request.input.format === "markdown"
    ? projectStructuredSpeech(request.input.text) : plainProjection(request.input.text);
  if (!projection.speechText.trim()) throw new ReadPlanError("EMPTY_INPUT");
  const [display] = structuredReadDisplay(projection, [projection.speechText], Math.max(2, projection.speechText.length));
  if (!display) throw new ReadPlanError("DISPLAY_UNAVAILABLE");
  const words: Plan["words"] = displayTokens(display.text).map((token, index) => ({ index, text: token[0],
    display: [token.index, token.index + token[0].length] }));
  const cut = planSynthesisUnits({ units: sourceUnits(projection), max_chars: limits.max_chars[request.use], first_piece_raw });
  let cursor = 0;
  const pieces: Plan["pieces"] = cut.map((piece, index) => {
    const word_start = cursor;
    const segments: Plan["pieces"][number]["segments"] = piece.segments.map(segment => {
      const start = cursor;
      for (const token of displayTokens(segment.text)) {
        if (words[cursor]?.text !== token[0]) throw new ReadPlanError("TOKEN_MISMATCH");
        cursor++;
      }
      return { word_start: start, word_end: cursor, kind: segment.kind === "list_item" ? "item" : segment.kind,
        pause_after_ms: segment.pause_after_ms, pause_in: segment.pause_in };
    });
    return { piece_id: `${identity.session_id}:piece:${index}`, index, word_start, word_end: cursor,
      raw: first_piece_raw && index === 0, segments };
  });
  if (cursor !== words.length) throw new ReadPlanError("TOKEN_MISMATCH");
  const blocks = display.blocks.map(block => json.read(block, "$.display_document.blocks"));
  return { plan: { type: "plan", ...identity, display_document: { ...display, blocks }, words, pieces, engine: { ...engine } },
    requests: cut.map((piece, piece_index) => ({ piece_index, text: piece.segments[0].text })) };
}

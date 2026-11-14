import { json } from "../engine/messages/schema";
import type { Limits, Message } from "../engine/messages/messages";
import { displayTokens } from "../text/voicelayer/display-tokens";
import { structuredReadDisplay } from "../text/voicelayer/structured-display";
import { projectStructuredSpeech, type StructuredSpeech } from "../text/voicelayer/structured-speech";
import { planSynthesisUnits, type SynthesisSourceUnit } from "./synthesis-units";

// VoiceLayer tts.ts:3673 decorates the whole read with its existing 400-char layout budget.
const DISPLAY_BUDGET = 400;
// VoiceLayer prosody.ts:99,391: only a terminal mark earns the sentence pause.
const TERMINAL = /[.!?…。！？]["'”’)\]]*$/u;
// VL prosody.ts:395: heading intonation changes only the request, never document words.
const headingText = (text: string) => text.endsWith(":") ? `${text.slice(0, -1)}.` : TERMINAL.test(text) ? text : `${text}.`;
type Plan = Omit<Message<"plan">, "protocol" | "owner_epoch" | "seq">;
export class ReadPlanError extends Error {
  constructor(readonly code: "EMPTY_INPUT" | "DISPLAY_UNAVAILABLE" | "CHUNK_MISMATCH" | "CUTTER_REJECTED", options?: ErrorOptions) {
    super(code, options);
    this.name = "ReadPlanError";
  }
}

// Plain input bypasses Markdown in VL socket-handlers.ts:308-314. Identity ranges
// let the same display builder decorate it without interpreting literal markup.
function plainProjection(text: string): StructuredSpeech {
  // Structure offsets are source offsets: identity speech maps them exactly, including markup.
  const blocks = projectStructuredSpeech(text).blocks;
  return { displayText: text, speechText: text,
    blocks, ranges: blocks.map(block => ({ kind: "identity", source: { ...block.source },
      display: { ...block.source }, speech: { ...block.source } })) };
}

interface LocatedUnit extends SynthesisSourceUnit { speech_start: number }

function sourceUnits(projection: StructuredSpeech): LocatedUnit[] {
  const units: LocatedUnit[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  let rangeIndex = 0;
  const pause = (ms: number) => { const last = units.at(-1); if (last) last.pause_after_ms = Math.max(last.pause_after_ms, ms); };
  // VL prosody.ts:140,199,201: blank lines and following headings raise the preceding pause.
  // Use projection blocks, not the display builder's budget-dependent runs.
  for (const [blockIndex, block] of projection.blocks.entries()) {
    if (block.kind === "separator") pause(1000);
    if (block.kind === "heading") pause(600);
    while (rangeIndex < projection.ranges.length && projection.ranges[rangeIndex].source.end <= block.source.start) rangeIndex++;
    let first: number | undefined, end = 0;
    for (let index = rangeIndex; index < projection.ranges.length && projection.ranges[index].source.start < block.source.end; index++) {
      const range = projection.ranges[index];
      if (range.kind !== "insertion" && range.speech.end > range.speech.start) {
        first ??= range.speech.start; end = range.speech.end;
      }
    }
    if (first === undefined) continue;
    const speech_start = first;
    const text = projection.speechText.slice(speech_start, end);
    if (!text.trim()) continue;
    const raw = projection.displayText.slice(block.source.start, block.source.end);
    if (block.kind === "heading") {
      // VL prosody.ts:202-203: h1=900, h2/h3=750, other headings=800.
      const level = raw.match(/^\s{0,3}(#{1,6})\s/)?.[1].length
        ?? (/\n\s{0,3}=+\s*$/.test(raw) ? 1 : 2);
      units.push({ kind: "heading", text, speech_start, pause_after_ms: level === 1 ? 900 : level <= 3 ? 750 : 800 });
    } else if (block.kind === "list-item") {
      // VL prosody.ts:207-225 counts source words after the marker; >=6 is long.
      const body = raw.replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?/, "");
      const count = body.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
      units.push({ kind: "list_item", text, speech_start, pause_after_ms: count >= 6 ? 700 : 450 });
    } else {
      // VL prosody.ts:229-252 treats code/table as prose. Sentence segmentation
      // flattens CR/LF without changing UTF-16 offsets (:284-288).
      const prose = (start: number, end: number) => {
        const text = projection.speechText.slice(start, end), flat = text.replace(/[\r\n]/g, " ");
        // Whitespace boundaries preserve words; unspaced CJK stays one possibly over-cap unit.
        const starts = [...segmenter.segment(flat)].map(sentence => sentence.index)
          .filter(at => at === 0 || /\s/u.test(flat[at - 1]));
        starts.forEach((at, index) => {
          const slice = text.slice(at, starts[index + 1] ?? text.length);
          if (slice.trim()) units.push({ kind: "sentence", text: slice, speech_start: start + at,
            pause_after_ms: TERMINAL.test(slice.trim()) ? 550 : 0 });
        });
      };
      let cursor = speech_start, mappingIndex = rangeIndex, structuralLine = true;
      const speechAt = (offset: number) => {
        while (mappingIndex < projection.ranges.length && projection.ranges[mappingIndex].source.end <= offset) mappingIndex++;
        const range = projection.ranges[mappingIndex];
        return !range ? projection.speechText.length : range.kind === "identity"
          ? range.speech.start + Math.max(0, offset - range.source.start) : range.speech.start;
      };
      // VL prosody.ts:231-245: only paragraph-initial bold/label runs are structural.
      for (const line of raw.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
        const lineText = line[0].replace(/[\r\n]+$/, "");
        if (!lineText.trim() || block.kind !== "paragraph" || !structuralLine) continue;
        const bold = /^(\*\*|__)(?=\S)[^\n]*?\S\1[ \t]*$/.test(lineText) && !/:[*_]*\s*$/.test(lineText);
        if (!bold) {
          const label = lineText.trimStart().match(/^(\*\*|__)([^*_\n]*?\S)\1(:?)(?=[ \t]+\S)/);
          structuralLine = !!label && (label[2].endsWith(":") || label[3] === ":");
          continue;
        }
        const start = speechAt(block.source.start + line.index), stop = speechAt(block.source.start + line.index + lineText.length);
        prose(cursor, start); pause(600);
        const heading = projection.speechText.slice(start, stop);
        if (heading.trim()) units.push({ kind: "heading", text: heading, speech_start: start, pause_after_ms: 800 });
        cursor = stop;
      }
      prose(cursor, end);
      // VL prosody.ts:250-251: a colon before the next list earns listIntro=600.
      let next = blockIndex + 1;
      while (projection.blocks[next]?.kind === "separator") next++;
      if (/:\s*$/.test(raw) && projection.blocks[next]?.kind === "list-item") pause(600);
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
  const [display] = structuredReadDisplay(projection, [projection.speechText], DISPLAY_BUDGET);
  if (!display) throw new ReadPlanError("DISPLAY_UNAVAILABLE");
  const words: Plan["words"] = displayTokens(display.text).map((token, index) => ({ index, text: token[0],
    display: [token.index, token.index + token[0].length] }));
  const units = sourceUnits(projection);
  const positions = units.map(unit => ({ chunks: [...unit.text.matchAll(/\S+/gu)], used: 0 }));
  let cut: ReturnType<typeof planSynthesisUnits>;
  try { cut = planSynthesisUnits({ units, max_chars: limits.max_chars[request.use], first_piece_raw }); }
  catch (cause) { throw new ReadPlanError("CUTTER_REJECTED", { cause }); }
  let cursor = 0;
  const pieces: Plan["pieces"] = cut.map((piece, index) => {
    const word_start = cursor;
    const segments: Plan["pieces"][number]["segments"] = piece.segments.map(segment => {
      const start = cursor;
      const unitIndex = segment.source_units[0];
      const position = positions[unitIndex];
      if (!position) throw new ReadPlanError("CHUNK_MISMATCH");
      const first = position.chunks[position.used];
      for (const chunk of segment.text.matchAll(/\S+/gu)) {
        if (position.chunks[position.used]?.[0] !== chunk[0]) throw new ReadPlanError("CHUNK_MISMATCH");
        position.used++;
      }
      const last = position.chunks[position.used - 1];
      if (!first || !last) throw new ReadPlanError("CHUNK_MISMATCH");
      const speechStart = units[unitIndex].speech_start + first.index;
      const speechEnd = units[unitIndex].speech_start + last.index + last[0].length;
      // Only document tokens own word indices; segment-local tokenization loses context.
      if (words[cursor] && words[cursor].display[0] < speechStart) throw new ReadPlanError("CHUNK_MISMATCH");
      while (cursor < words.length && words[cursor].display[0] < speechEnd) {
        if (words[cursor].display[1] > speechEnd) throw new ReadPlanError("CHUNK_MISMATCH");
        cursor++;
      }
      return { word_start: start, word_end: cursor, kind: segment.kind === "list_item" ? "item" : segment.kind,
        pause_after_ms: segment.pause_after_ms, pause_in: segment.pause_in };
    });
    return { piece_id: `${identity.session_id}:piece:${index}`, index, word_start, word_end: cursor,
      raw: first_piece_raw && index === 0, segments };
  });
  if (cursor !== words.length) throw new ReadPlanError("CHUNK_MISMATCH");
  const blocks = display.blocks.map(block => json.read(block, "$.display_document.blocks"));
  return { plan: { type: "plan", session_id: identity.session_id, attempt_id: identity.attempt_id, display_document: { ...display, blocks }, words, pieces, engine: { family: engine.family, profile_revision: engine.profile_revision, voice: engine.voice } },
    requests: cut.map((piece, piece_index) => ({ piece_index, text: piece.segments[0].kind === "heading" ? headingText(piece.segments[0].text) : piece.segments[0].text })) };
}

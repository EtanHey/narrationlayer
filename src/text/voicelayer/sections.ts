import type { DisplayBlock, ProjectionRange, StructuredSpeech, TextRange } from "./structured-speech";

export interface SectionChunk {
  sectionId: string;
  /** Exact global speech offsets; concatenating slices preserves every character. */
  speech: TextRange;
  /** Replacement anchors may repeat across chunks; they are never interpolated. */
  ranges: ProjectionRange[];
}
export interface SpeechSection {
  /** Source-offset identity, independent of generation budget or chunk index. */
  id: string;
  kind: "heading" | "block";
  source: TextRange;
  display: TextRange;
  speech: TextRange;
  blocks: DisplayBlock[];
  chunks: SectionChunk[];
}
export interface SectionMap { sections: SpeechSection[]; chunks: SectionChunk[] }

/**
 * D5: each captured heading starts a section. Before the first heading, or in
 * headingless text, use paragraphs/list items/table rows/code blocks as fallback.
 * Separators stay attached to their preceding section (leading ones to the first).
 * The caller supplies its provider's existing UTF-16 chunk budget; no audio/wire
 * state or generation policy is changed here. A single oversized grapheme is
 * emitted intact even if it exceeds that budget. Input must obey FMT1 partitions.
 */
export function buildSectionMap(projection: StructuredSpeech, maxChunkChars: number): SectionMap {
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 2) {
    throw new RangeError("Chunk budget must be an integer of at least two UTF-16 units");
  }
  const { blocks, ranges, displayText, speechText } = projection;
  if (!displayText.length) return { sections: [], chunks: [] };
  // Segment once, not once per hard cut: long unspaced runs stay bounded work.
  const graphemeEnds = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(speechText),
    part => part.index + part.segment.length,
  );
  const firstHeading = blocks.findIndex(block => block.kind === "heading");
  const anchors = blocks.flatMap((block, index) => {
    if (block.kind === "separator" || block.kind === "table-separator") return [];
    if (firstHeading >= 0 && index > firstHeading && block.kind !== "heading") return [];
    return [{ start: block.source.start, kind: block.kind === "heading" ? "heading" as const : "block" as const }];
  });
  if (!anchors.length) anchors.push({ start: 0, kind: "block" });
  anchors[0].start = 0;

  function speechOffset(offset: number): number {
    if (offset === displayText.length) return speechText.length;
    const range = ranges[lowerBound(ranges.length, i => ranges[i].source.end < offset)];
    if (!range) return 0; // Entirely omitted input has no speech.
    if (offset === range.source.start) return range.speech.start;
    if (offset === range.source.end) return range.speech.end;
    if (range.kind === "omission") return range.speech.start;
    if (range.kind === "identity") return range.speech.start + offset - range.source.start;
    // A future normalization spanning a block boundary needs finer producer ranges.
    throw new RangeError("Section boundary falls inside a replacement span");
  }

  const sections = anchors.map((anchor, index): SpeechSection => {
    const source = { start: anchor.start, end: anchors[index + 1]?.start ?? displayText.length };
    const speech = { start: speechOffset(source.start), end: speechOffset(source.end) };
    const firstBlock = lowerBound(blocks.length, i => blocks[i].source.end <= source.start);
    let afterBlock = firstBlock;
    while (afterBlock < blocks.length && blocks[afterBlock].source.start < source.end) afterBlock++;
    const sectionBlocks = blocks.slice(firstBlock, afterBlock).map(block => ({
      ...block, source: { ...block.source }, display: { ...block.display },
    }));
    const section: SpeechSection = {
      id: `section:${source.start}`, kind: anchor.kind, source, display: { ...source }, speech,
      blocks: sectionBlocks, chunks: [],
    };
    const boundaries = sectionBlocks.map(block => speechOffset(block.source.start));
    let cursor = speech.start;
    while (cursor < speech.end) {
      const limit = Math.min(cursor + maxChunkChars, speech.end);
      let end = limit;
      if (limit < speech.end) {
        const nextBoundary = lowerBound(boundaries.length, i => boundaries[i] <= limit);
        const boundary = boundaries[nextBoundary - 1];
        if (boundary > cursor) end = boundary;
        else {
          // Keep whitespace in the exact slices, including normalized join spaces.
          const space = speechText.slice(cursor, limit).lastIndexOf(" ");
          if (space > 0) end = cursor + space + 1;
          else {
            const nextGrapheme = lowerBound(graphemeEnds.length, i => graphemeEnds[i] <= limit);
            const previousEnd = graphemeEnds[nextGrapheme - 1];
            // No boundary fits: keep the one oversized atom intact and advance.
            end = previousEnd > cursor ? previousEnd : graphemeEnds[nextGrapheme];
          }
        }
      }
      section.chunks.push({ sectionId: section.id, speech: { start: cursor, end },
        ranges: chunkRanges(ranges, cursor, end, section) });
      cursor = end;
    }
    return section;
  });
  return { sections, chunks: sections.flatMap(section => section.chunks) };
}

function lowerBound(length: number, before: (index: number) => boolean): number {
  let low = 0, high = length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (before(middle)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function chunkRanges(ranges: ProjectionRange[], start: number, end: number, section: SpeechSection): ProjectionRange[] {
  const result: ProjectionRange[] = [];
  let index = lowerBound(ranges.length, i => ranges[i].speech.end < start);
  for (; index < ranges.length && ranges[index].speech.start <= end; index++) {
    const range = ranges[index];
    if (range.kind === "omission") {
      const point = range.speech.start;
      if (point < start || point > end || (point === end && end !== section.speech.end)) continue;
      const left = Math.max(range.source.start, section.source.start);
      const right = Math.min(range.source.end, section.source.end);
      if (left < right) result.push({ ...range, source: { start: left, end: right },
        display: { start: left, end: right }, speech: { start: point, end: point } });
      continue;
    }
    const left = Math.max(start, range.speech.start), right = Math.min(end, range.speech.end);
    if (left >= right) continue;
    const source = { ...range.source }, display = { ...range.display };
    if (range.kind === "identity") {
      source.start += left - range.speech.start;
      source.end -= range.speech.end - right;
      display.start += left - range.speech.start;
      display.end -= range.speech.end - right;
    }
    result.push({ ...range, source, display, speech: { start: left, end: right } });
  }
  return result;
}

import { displayTokens } from "./display-tokens";
import { buildSectionMap } from "./sections";
import type { DisplayBlockKind, ProjectionRange, StructuredSpeech, TextRange } from "./structured-speech";

/** Optional layout only. text is the EXACT legacy chunk; offsets are UTF-16, never audio times. */
export interface StructuredChunkDisplay {
  version: 1;
  text: string;
  speech_start: number;
  blocks: {
    kind: DisplayBlockKind;
    source: TextRange;
    speech: TextRange;
    ranges: ProjectionRange[];
    word_start: number;
    word_end: number;
    section_id: string;
    starts_block: boolean;
    starts_section: boolean;
    marker?: string;
  }[];
}

/** Decorate existing chunks, never re-chunk synthesis. Unknown sanitization mappings fail to legacy. */
export function structuredReadDisplay(projection: StructuredSpeech, texts: string[], budget: number): (StructuredChunkDisplay | undefined)[] {
  try { return projectReadDisplay(projection, texts, budget); }
  catch { return texts.map(() => undefined); } // Optional layout must never refuse legacy speech.
}

function projectReadDisplay(projection: StructuredSpeech, texts: string[], budget: number): (StructuredChunkDisplay | undefined)[] {
  const map = buildSectionMap(projection, budget);
  // P14a's semantic units share a display section when their existing budget permits it.
  const groups: TextRange[] = [];
  for (const section of map.sections) for (const unit of section.chunks) {
    const previous = groups.at(-1);
    if (previous && !(section.kind === "heading" && unit === section.chunks[0]) && unit.speech.end - previous.start <= budget) {
      previous.end = unit.speech.end;
    } else groups.push({ ...unit.speech });
  }
  let rangeIndex = 0;
  const blocks = map.sections.flatMap(section => section.blocks).flatMap(block => {
    while (rangeIndex < projection.ranges.length && projection.ranges[rangeIndex].source.end <= block.source.start) rangeIndex++;
    const spoken: ProjectionRange[] = [];
    for (let index = rangeIndex; index < projection.ranges.length && projection.ranges[index].source.start < block.source.end; index++) {
      const range = projection.ranges[index];
      if (range.source.end > block.source.start && range.speech.end > range.speech.start) spoken.push(range);
    }
    if (!spoken.length) return [];
    return [{ ...block, speech: { start: spoken[0].speech.start, end: spoken[spoken.length - 1].speech.end } }];
  });
  let cursor = 0, blockIndex = 0, groupIndex = 0, speechRangeIndex = 0;
  const result: (StructuredChunkDisplay | undefined)[] = [];
  for (const text of texts) {
    const start = projection.speechText.indexOf(text, cursor);
    if (start < 0 || projection.speechText.slice(cursor, start).trim()) return texts.map(() => undefined);
    cursor = start + text.length;
    const tokens = displayTokens(text);
    const runs: StructuredChunkDisplay["blocks"] = [];
    for (let word = 0; word < tokens.length;) {
      const at = start + tokens[word].index;
      while (blockIndex < blocks.length && blocks[blockIndex].speech.end <= at) blockIndex++;
      while (groupIndex < groups.length && groups[groupIndex].end <= at) groupIndex++;
      const block = blocks[blockIndex], group = groups[groupIndex];
      if (!block || !group || at < block.speech.start || at < group.start) return texts.map(() => undefined);
      const first = word;
      while (word < tokens.length && start + tokens[word].index < Math.min(block.speech.end, group.end)) word++;
      const speech = { start: at, end: start + tokens[word - 1].index + tokens[word - 1][0].length };
      while (speechRangeIndex < projection.ranges.length && projection.ranges[speechRangeIndex].speech.end <= speech.start) speechRangeIndex++;
      const ranges: ProjectionRange[] = [];
      for (let index = speechRangeIndex; index < projection.ranges.length && projection.ranges[index].speech.start < speech.end; index++) {
        ranges.push(...clipRange(projection.ranges[index], speech));
      }
      const starts_block = at === block.speech.start;
      // Kind comes from FMT1; read its captured marker, never infer a list from inline digits.
      const marker = starts_block && block.kind === "list-item"
        ? projection.displayText.slice(block.source.start, block.source.end).trimStart().match(/^\S+/u)?.[0] : undefined;
      runs.push({ kind: block.kind, source: { ...block.source }, speech, ranges,
        word_start: first, word_end: word, section_id: `section:${group.start}`, starts_block,
        starts_section: !projection.speechText.slice(group.start, at).trim(),
        ...(marker && !/^\d+[.)]$/.test(marker) && marker.length <= 32 ? { marker } : {}) });
    }
    result.push({ version: 1, text, speech_start: start, blocks: runs });
  }
  return projection.speechText.slice(cursor).trim() ? texts.map(() => undefined) : result;
}

function clipRange(range: ProjectionRange, speech: TextRange): ProjectionRange[] {
  const start = Math.max(range.speech.start, speech.start), end = Math.min(range.speech.end, speech.end);
  if (start >= end) return [];
  // FMT1 replacements keep their WHOLE source anchor; only identities permit interior offsets.
  const source = range.kind === "identity"
    ? { start: range.source.start + start - range.speech.start, end: range.source.end - (range.speech.end - end) }
    : { ...range.source };
  return [{ ...range, source, display: { ...source }, speech: { start, end } }];
}

import { markdownSpeechLines } from "./markdown-to-speech";

/** Half-open UTF-16 code-unit offsets, suitable for JS slicing and macOS NSRange. */
export interface TextRange { start: number; end: number }

/**
 * Reusable by SPK1. A replacement maps the whole span, never proportional words.
 * Insertions have empty source/display spans; omissions have empty speech spans.
 * Only identity permits translating an interior offset by simple addition.
 */
export interface ProjectionRange {
  source: TextRange;
  display: TextRange;
  speech: TextRange;
  kind: "identity" | "replacement" | "insertion" | "omission";
}

export type DisplayBlockKind = "heading" | "paragraph" | "list-item" | "table-row" |
  "table-separator" | "separator" | "code";
export interface DisplayBlock {
  kind: DisplayBlockKind;
  source: TextRange;
  display: TextRange;
}
export interface StructuredSpeech {
  /** Exact captured input. No missing structure is reconstructed. */
  displayText: string;
  /** Markdown speech with source-line boundaries retained for lexical context. */
  speechText: string;
  blocks: DisplayBlock[];
  /** Ordered partitions of both input and speech (including zero-width edits). */
  ranges: ProjectionRange[];
}

export function projectStructuredSpeech(source: string): StructuredSpeech {
  const lines = markdownSpeechLines(source).filter(line => line.text);
  const ranges: ProjectionRange[] = [];
  let sourceCursor = 0, speechCursor = 0;
  const speech: string[] = [];
  function append(start: number, end: number, text: string) {
    const original = source.slice(start, end);
    ranges.push({
      source: { start, end }, display: { start, end },
      speech: { start: speechCursor, end: speechCursor + text.length },
      kind: start === end ? "insertion" : !text ? "omission" : original === text ? "identity" : "replacement",
    });
    sourceCursor = end;
    speechCursor += text.length;
    speech.push(text);
  }
  for (const line of lines) {
    if (sourceCursor < line.sourceStart) append(sourceCursor, line.sourceStart, "");
    if (speechCursor) append(line.sourceStart, line.sourceStart, "\n");
    append(line.sourceStart, line.sourceEnd, line.text);
  }
  if (sourceCursor < source.length) append(sourceCursor, source.length, "");
  return { displayText: source, speechText: speech.join(""), ranges, blocks: displayBlocks(source, lines) };
}

function displayBlocks(source: string, lines: ReturnType<typeof markdownSpeechLines>): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  // Fence recovery already decides exactly which source was collapsed to speech.
  const codeRanges = new Map(lines.filter(line => line.kind === "code")
    .map(line => [line.sourceStart, line.sourceEnd]));
  const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  const sourceLines = Array.from(source.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g));
  const tableRows = new Set<number>();
  for (let i = 0; i < sourceLines.length; i++) {
    if (!tableSeparator.test(sourceLines[i][1])) continue;
    if (i > 0 && sourceLines[i - 1][1].includes("|")) tableRows.add(sourceLines[i - 1].index);
    let row = i + 1;
    for (; row < sourceLines.length && sourceLines[row][1].includes("|"); row++) {
      tableRows.add(sourceLines[row].index);
    }
    i = row - 1;
  }
  const pattern = /([^\r\n]*)(?:\r\n|\r|\n|$)/g;
  for (let match = pattern.exec(source); match && match[0].length; match = pattern.exec(source)) {
    const start = match.index;
    let end = start + match[0].length;
    let kind: DisplayBlockKind;
    const codeEnd = codeRanges.get(start);
    if (codeEnd !== undefined) {
      end = codeEnd;
      if (source.slice(end, end + 2) === "\r\n") end += 2;
      else if (/[\r\n]/.test(source[end] ?? "")) end++;
      pattern.lastIndex = end;
      kind = "code";
    } else {
      const text = match[1];
      const previous = blocks.at(-1);
      // A setext underline belongs to the immediately preceding paragraph.
      if (/^\s{0,3}(?:=+|-+)\s*$/.test(text) && previous?.kind === "paragraph") {
        previous.kind = "heading";
        previous.source.end = end;
        previous.display.end = end;
        continue;
      }
      kind = !text.trim() ? "separator" : /^\s{0,3}#{1,6}\s+/.test(text) ? "heading" :
        /^\s*(?:[-+*]|\d+[.)])\s+/.test(text) ? "list-item" :
        tableSeparator.test(text) ? "table-separator" :
        (tableRows.has(start) || /^\s*\|.*\|\s*$/.test(text)) ? "table-row" : "paragraph";
    }
    const previous = blocks.at(-1);
    if (previous?.kind === kind && (kind === "paragraph" || kind === "separator")) {
      previous.source.end = end;
      previous.display.end = end;
    } else blocks.push({ kind, source: { start, end }, display: { start, end } });
  }
  return blocks;
}

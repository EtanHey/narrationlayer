import { describe, expect, it } from "bun:test";
import { projectStructuredSpeech } from "../../../src/text/voicelayer/structured-speech";
import { buildSectionMap } from "../../../src/text/voicelayer/sections";

function check(source: string, budget: number) {
  const projection = projectStructuredSpeech(source);
  const before = JSON.stringify(projection);
  const map = buildSectionMap(projection, budget);
  expect(JSON.stringify(projection)).toBe(before);
  expect(map.sections.map(s => source.slice(s.source.start, s.source.end)).join("")).toBe(source);
  expect(map.sections.flatMap(s => s.blocks).map(b => source.slice(b.source.start, b.source.end)).join("")).toBe(source);
  expect(map.sections.map(s => projection.speechText.slice(s.speech.start, s.speech.end)).join("")).toBe(projection.speechText);
  expect(map.chunks.map(c => projection.speechText.slice(c.speech.start, c.speech.end)).join("")).toBe(projection.speechText);
  for (const section of map.sections) {
    expect(section.display).toEqual(section.source);
    expect(section.id).toBe(`section:${section.source.start}`);
    expect(section.chunks.every(c => c.sectionId === section.id)).toBe(true);
  }
  for (const chunk of map.chunks) {
    const text = projection.speechText.slice(chunk.speech.start, chunk.speech.end);
    expect(text.length).toBeGreaterThan(0);
    if (text.length > budget) {
      expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]).toHaveLength(1);
    } else expect(text.length).toBeLessThanOrEqual(budget);
    expect(/[\uD800-\uDBFF]$/.test(text)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(text)).toBe(false);
    expect(chunk.ranges.map(r => projection.speechText.slice(r.speech.start, r.speech.end)).join("")).toBe(text);
    for (const range of chunk.ranges) if (range.kind === "identity") {
      expect(source.slice(range.source.start, range.source.end)).toBe(projection.speechText.slice(range.speech.start, range.speech.end));
    }
  }
  return map;
}

describe("stable section map", () => {
  it("uses headings, with block fallback for a preamble", () => {
    const source = "Intro.\n\n# One\n\nA paragraph.\n- First\n- Second\n\n## Two\nLast.";
    const map = check(source, 400);
    expect(map.sections.map(s => s.kind)).toEqual(["block", "heading", "heading"]);
    expect(map.sections.map(s => source.slice(s.source.start, s.source.end)))
      .toEqual(["Intro.\n\n", "# One\n\nA paragraph.\n- First\n- Second\n\n", "## Two\nLast."]);
  });

  it("falls back to paragraphs, list items and table rows without flattening them", () => {
    const source = "\nFirst paragraph.\nwrapped line.\n\n- Item\n- Item\n\n| A | | B |\n| --- | --- | --- |\n| C | | D |\n";
    const map = check(source, 400);
    expect(map.sections.map(s => s.blocks.find(b => b.kind !== "separator")?.kind))
      .toEqual(["paragraph", "list-item", "list-item", "table-row", "table-row"]);
  });

  it("keeps stable section IDs and offsets as oversized sections span different chunk budgets", () => {
    const source = "# Big\n\n" + "Repeated words 😀 שלום ".repeat(80) + "\n\n# End\nDone.";
    const small = check(source, 31), large = check(source, 100);
    expect(small.sections.map(s => [s.id, s.source, s.speech])).toEqual(large.sections.map(s => [s.id, s.source, s.speech]));
    expect(small.sections[0].chunks.length).toBeGreaterThan(large.sections[0].chunks.length);
  });

  it("prefers captured block boundaries within a chunk budget", () => {
    const source = "# H\n- One\n- Two\n- Three";
    const map = check(source, 10);
    const speech = projectStructuredSpeech(source).speechText;
    expect(map.chunks.map(c => speech.slice(c.speech.start, c.speech.end))).toEqual(["H\nOne.", "\nTwo.", "\nThree."]);
  });

  it("splits oversized replacements conservatively, never interpolating their source offsets", () => {
    const source = "# H\n[" + "label ".repeat(30) + "](https://example.com)";
    const projection = projectStructuredSpeech(source);
    const replacement = projection.ranges.find(r => r.kind === "replacement" && r.source.start > 0)!;
    const map = check(source, 20);
    const pieces = map.chunks.flatMap(c => c.ranges).filter(r => r.kind === "replacement" && r.source.start === replacement.source.start);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every(r => JSON.stringify(r.source) === JSON.stringify(replacement.source))).toBe(true);
  });

  for (const source of ["", " \r\n\t", "# שלום 😀\r\n\r\n😀".repeat(3), "Title\n====\n\nText", "Before\n```ts\n# hidden heading\n```\nAfter", "No•captured•structure", "x".repeat(200), "😀".repeat(40)]) {
    it(`conserves exact ranges for ${JSON.stringify(source.slice(0, 30))}`, () => { check(source, 7); });
  }

  it("does not treat headings inside fenced code as section boundaries", () => {
    expect(check("# Visible\n```ts\n# Hidden\n```\nAfter", 20).sections).toHaveLength(1);
  });

  it("handles empty/omitted speech without invented chunks", () => {
    expect(check(" \r\n\t", 10).chunks).toEqual([]);
    expect(check("", 10).sections).toEqual([]);
  });

  it("rejects budgets that cannot hold one Unicode scalar", () => {
    for (const budget of [0, 1, -1, 2.5, NaN, Infinity]) {
      expect(() => buildSectionMap(projectStructuredSpeech("Text"), budget)).toThrow(RangeError);
    }
  });
});

it("rejects replacement mappings that cross a logical section boundary", () => {
  const projection = projectStructuredSpeech("First\n\nSecond");
  projection.ranges = [{ source: { start: 0, end: projection.displayText.length },
    display: { start: 0, end: projection.displayText.length },
    speech: { start: 0, end: projection.speechText.length }, kind: "replacement" }];
  expect(() => buildSectionMap(projection, 10)).toThrow("Section boundary falls inside a replacement span");
});

it("is deterministic and preserves frozen producer metadata", () => {
  const projection = projectStructuredSpeech("# H\n\nSame same.\n- שלום 😀");
  function freeze(value: any) {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(projection);
  expect(buildSectionMap(projection, 7)).toEqual(buildSectionMap(projection, 7));
});

it("keeps minimum-size Unicode chunks and long unspaced tokens bounded", () => {
  check("😀שלום".repeat(80), 2);
  check("x".repeat(10000), 64);
});

// Cursor R1: surrogate-safe cuts still split ZWJ, regional-indicator and modifier clusters.
for (const atom of ["👨‍👩‍👧‍👦", "🇺🇸", "👍🏽", "👨‍👩‍👧‍👦🇺🇸👍🏽"]) {
  for (const budget of [10, 13, 17, 23, 50]) {
    it(`keeps grapheme boundaries for ${atom} at budget ${budget}`, () => {
      const source = atom.repeat(30);
      const projection = projectStructuredSpeech(source);
      const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(projection.speechText)];
      const boundaries = new Set([0, ...segments.map(s => s.index + s.segment.length)]);
      const map = check(source, budget);
      for (const chunk of map.chunks) {
        expect(boundaries.has(chunk.speech.start)).toBe(true);
        expect(boundaries.has(chunk.speech.end)).toBe(true);
      }
    });
  }
}

it("emits one oversized grapheme intact and makes progress", () => {
  const atom = "👨‍👩‍👧‍👦";
  const source = atom.repeat(3);
  const map = check(source, 2);
  expect(map.chunks.map(c => source.slice(c.speech.start, c.speech.end))).toEqual([atom, atom, atom]);
});

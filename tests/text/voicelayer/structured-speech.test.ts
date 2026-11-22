import { describe, expect, it } from "bun:test";
import { projectStructuredSpeech } from "../../../src/text/voicelayer/structured-speech";
import { markdownToSpeech } from "../../../src/text/voicelayer/markdown-to-speech";

const fixtures = [
  "# Heading\n\nYou confirmed:\n- Cloned voice\n- Fast voice\n\nNext paragraph.",
  "| Name | Empty | Value |\n| --- | --- | ---: |\n| A | | 5 |\n| A | | 5 |",
  "# שלום 😀\r\n\r\nשלום שלום\r\n* עולם 😀\r\n",
  "Before\n```ts\nconst secret = 42;\n```\nAfter",
  "x = 1;\n```\nHere is the explanation.\n```\nsecret()",
  "[A link](https://example.com/a_(b)) and __init__\n\n[ref]: https://example.com",
  "", "  \r\n\t", "Captured•item one•item two",
];

describe("structured speech projections", () => {
  for (const source of fixtures) it(`conserves source and legacy speech words: ${JSON.stringify(source)}`, () => {
    const result = projectStructuredSpeech(source);
    expect(result.displayText).toBe(source);
    expect(result.speechText.replace(/\n/g, " ")).toBe(markdownToSpeech(source));
    expect(result.blocks.map(block => source.slice(block.source.start, block.source.end)).join("")).toBe(source);
    let sourceEnd = 0, speechEnd = 0;
    for (const range of result.ranges) {
      expect(range.source.start).toBe(sourceEnd);
      expect(range.speech.start).toBe(speechEnd);
      expect(range.display).toEqual(range.source);
      expect(range.source.end).toBeGreaterThanOrEqual(range.source.start);
      expect(range.speech.end).toBeGreaterThanOrEqual(range.speech.start);
      sourceEnd = range.source.end;
      speechEnd = range.speech.end;
    }
    expect(sourceEnd).toBe(source.length);
    expect(speechEnd).toBe(result.speechText.length);
  });

  it("keeps paragraph, list item and table row boundaries including empty cells", () => {
    const source = "You confirmed:\n- Cloned voice\n- Fast voice\n\n| A | | B |\n| --- | --- | --- |\n| C | | D |";
    const result = projectStructuredSpeech(source);
    expect(result.blocks.map(b => b.kind)).toEqual([
      "paragraph", "list-item", "list-item", "separator", "table-row", "table-separator", "table-row",
    ]);
    expect(result.speechText).toBe("You confirmed:\nCloned voice.\nFast voice.\nA, B.\nC, D.");
    expect(result.blocks.filter(b => b.kind === "table-row").map(b => source.slice(b.source.start, b.source.end)))
      .toEqual(["| A | | B |\n", "| C | | D |"]);
  });

  it("uses UTF-16 offsets and distinguishes replacement from exact identity", () => {
    const result = projectStructuredSpeech("שלום 😀\n- שלום 😀");
    expect(result.ranges[0]).toEqual({ source: { start: 0, end: 7 }, display: { start: 0, end: 7 }, speech: { start: 0, end: 7 }, kind: "identity" });
    expect(result.ranges.some(r => r.kind === "replacement")).toBe(true);
    expect(result.ranges.some(r => r.kind === "insertion")).toBe(true);
  });

  it("does not invent a lost list from inline bullet glyphs", () => {
    expect(projectStructuredSpeech("Captured•item one•item two").blocks.map(b => b.kind)).toEqual(["paragraph"]);
  });

  it("maps a complete fenced block as one conservative replacement", () => {
    const source = "Before\n```ts\nsecret()\n```\nAfter";
    const result = projectStructuredSpeech(source);
    const range = result.ranges.find(r => result.speechText.slice(r.speech.start, r.speech.end) === "code block")!;
    expect(source.slice(range.source.start, range.source.end)).toBe("```ts\nsecret()\n```");
    expect(range.kind).toBe("replacement");
    expect(result.blocks.map(b => b.kind)).toEqual(["paragraph", "code", "paragraph"]);
  });
});

it("recognizes setext headings without guessing inline pipe prose is a table", () => {
  const source = "Title\n=====\n\nUse A | B in prose.\n\nNext\n-----\nBody";
  const result = projectStructuredSpeech(source);
  expect(result.blocks.map(b => b.kind)).toEqual(["heading", "separator", "paragraph", "separator", "heading", "paragraph"]);
  expect(result.blocks.map(b => source.slice(b.source.start, b.source.end)).join("")).toBe(source);
});

it("retains standard table rows without outer pipes", () => {
  const source = "Name | Empty | Value\n--- | --- | ---:\nA | | 5\nA | | 5\n\nUse A | B in prose.";
  const result = projectStructuredSpeech(source);
  expect(result.blocks.map(b => b.kind)).toEqual(["table-row", "table-separator", "table-row", "table-row", "separator", "paragraph"]);
  expect(result.blocks.map(b => source.slice(b.source.start, b.source.end)).join("")).toBe(source);
});

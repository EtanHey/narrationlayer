import { expect, test, spyOn } from "bun:test";
import { planRead, ReadPlanError } from "../../src/plan/read-plan";
import { displayTokens } from "../../src/text/voicelayer/display-tokens";
import { parseEvent, parseRequest } from "../../src/engine/messages/parser";

import { projectStructuredSpeech } from "../../src/text/voicelayer/structured-speech";
import { structuredReadDisplay } from "../../src/text/voicelayer/structured-display";
import pauseFixtures from "./fixtures/pause-parity.json";
import * as cutter from "../../src/plan/synthesis-units";

const engine = { family: "edge", profile_revision: "fixture-v1", voice: "synthetic" };
const identity = { session_id: "session-fixture", attempt_id: "attempt-fixture" };
function read(text: string, max_chars = 60, format: "plain" | "markdown" = "markdown", first_piece_raw = false, overrides: Partial<Parameters<typeof planRead>[0]> = {}) {
  const request = parseRequest({ protocol: "nl.engine/1", type: "narrate", request_id: "req-fixture",
    idempotency_key: "fixture", use: "read", input: { text, format },
    voice: { profile: "fixture", require_clone: false, fallback: "none" }, delivery: "pieces" });
  if (!request.ok || request.value.type !== "narrate") throw new Error("fixture request");
  return planRead({ request: request.value, limits: { max_chars: { read: max_chars, speak: 80, ask_prompt: 90 },
    lookahead: 1, aligner_reap_ms: 100 }, identity, engine, first_piece_raw, ...overrides });
}
const shapes = "# Orchard notes\n\n- Apples\n- Gather ripe pears\n- Gather six ripe pears for breakfast\n- Label: keep these ripe apples safely.\n- Run `fruit_check` before storing apples.\n- Visit [the orchard](https://example.test) before dawn.\n- Visit https://example.test before dawn.\n\nThese green apples grow beside the wall, these golden pears grow beside the gate, and those plums grow near the river.";
const fixtures = [shapes, "| Fruit | Color |\n| --- | --- |\n| Pear | Green |",
  "Before the example.\n```ts\nconst fruit = 2;\n```\nAfter the example.",
  "> Watch **bright** stars and _quiet_ clouds.", "- Parent fruit\n  - Child fruit\n  - More child fruit",
  "2. Gather ripe pears\n3. Wash ripe apples", "# שלום 😀\n\nהעץ ירוק מאוד. השמש זורחת היום.",
  "Title\n=====\n\nOther\n-----\n\nPick client/server.\nWrap   soft\nlines carefully.",
  "`-1 aa/bb c d e f`", "`1.2 aa/bb c d e f`",
  "# One\n---\n\n## Two\n\n### Three\n\n#### Four\n\nTail sentence."];
function partition(result: ReturnType<typeof read>) {
  const { plan, requests } = result;
  let cursor = 0, chunkIndex = 0;
  const chunks = [...plan.display_document.text.matchAll(/\S+/gu)];
  plan.pieces.forEach((piece, index) => {
    expect(piece.index).toBe(index);
    expect(piece.word_start).toBe(cursor);
    for (const segment of piece.segments) {
      expect(segment.word_start).toBe(cursor);
      const requestText = requests[index].text;
      const originalText = plan.display_document.text.slice(plan.words[segment.word_start].display[0], plan.words[segment.word_end - 1].display[1]).replace(/\s+/gu, " ");
      const spoken = originalText.match(/\S+/gu) ?? [];
      const expected = segment.kind === "heading" ? (originalText.endsWith(":") ? `${originalText.slice(0, -1)}.` : /[.!?…。！？]["'”’)\]]*$/u.test(originalText) ? originalText : `${originalText}.`) : originalText;
      expect(requestText).toBe(expected);
      const covered = chunks.slice(chunkIndex, chunkIndex + spoken.length);
      expect(covered.map(chunk => chunk[0])).toEqual(spoken);
      const start = covered[0].index, end = covered.at(-1)!.index + covered.at(-1)![0].length;
      const contained = plan.words.filter(word => word.display[0] >= start && word.display[1] <= end);
      expect(plan.words.slice(segment.word_start, segment.word_end)).toEqual(contained);
      chunkIndex += spoken.length;
      cursor = segment.word_end;
    }
    expect(piece.word_end).toBe(cursor);
  });
  expect(cursor).toBe(plan.words.length);
  expect(chunkIndex).toBe(chunks.length);
}

test("partition: every document word belongs to exactly one segment and piece", () => {
  for (const text of fixtures) for (const cap of [11, 14, 60, 400]) partition(read(text, cap));
});
test("every plan parses: the projected fixtures are wire events", () => {
  for (const text of fixtures) {
    const { plan } = read(text);
    expect(parseEvent({ ...plan, protocol: "nl.engine/1", owner_epoch: 1, seq: 1 })).toEqual({ ok: true, value: { ...plan, protocol: "nl.engine/1", owner_epoch: 1, seq: 1 } });
  }
});
test("WORD-01 local half: words equal displayTokens with UTF-16 offsets", () => {
  for (const text of fixtures) {
    const { plan } = read(text);
    expect(plan.words).toEqual(displayTokens(plan.display_document.text).map((token, index) => ({ index,
      text: token[0], display: [token.index, token.index + token[0].length] satisfies [number, number] })));
  }
});
test("PLAN-01 and PLAN-D5: small remainders join; whole small units stand", () => {
  expect(read("# Bud\n\nOne two three four five.", 14).requests.map(r => r.text)).toEqual(["Bud.", "One two three four five."]);
  expect(read("One two three four five six.", 14).requests.map(r => r.text)).toEqual(["One two three", "four five six."]);
});
test("PLAN-02 and PLAN-D4: later fitting phrase mark wins over colon; internal cuts have no pause", () => {
  const { plan, requests } = read("# Notes\n\nLabel: one two three, four five six seven eight nine.\n\nTail follows here.", 22);
  expect(requests[1].text).toBe("Label: one two three,");
  expect(plan.pieces[1].segments[0].pause_after_ms).toBe(0);
  expect(read("One two three four five six seven eight.", 22).requests[0].text).toBe("One two three four");
});
test("PLAN-03 first fixture: headings and items stay whole; only long sentence cuts", () => {
  const { plan, requests } = read(shapes);
  expect(requests.slice(0, 8).map(r => r.text)).toEqual(["Orchard notes.", "Apples.", "Gather ripe pears.",
    "Gather six ripe pears for breakfast.", "Label: keep these ripe apples safely.", "Run fruit_check before storing apples.",
    "Visit the orchard before dawn.", "Visit link before dawn."]);
  expect(requests.length).toBeGreaterThan(9);
  expect(plan.pieces.slice(1, 8).every(piece => piece.segments[0].kind === "item")).toBe(true);
  expect(requests.slice(8, -1).every(r => /[,;:—–-]$/.test(r.text))).toBe(true);
});
test("PAUSE-PL-01: authored pauses have one owner; raw piece zero moves its pause", () => {
  for (const raw of [false, true]) {
    const { plan } = read("# Orchard\n\n- Pick ripe pears\n- Pick six ripe pears for breakfast\n\nFirst sentence grows. Next sentence flowers.\n\nTail grows here.", 400, "markdown", raw);
    expect(plan.pieces.flatMap(p => p.segments.map(s => s.pause_after_ms))).toEqual([1000, 450, 1000, 550, 1000, 0]);
    expect(plan.pieces.filter(p => p.raw).length).toBe(raw ? 1 : 0);
    expect(plan.pieces.flatMap(p => p.segments).filter(s => s.pause_in === "next_piece_start").length).toBe(raw ? 1 : 0);
    expect(plan.pieces[0].segments[0].pause_in).toBe(raw ? "next_piece_start" : "this_piece_end");
  }
});
test("last unit pause is zero, including a lone raw heading", () => {
  for (const text of ["# Heading", "- Pick ripe pears", "One sentence."]) {
    expect(read(text, 60, "markdown", true).plan.pieces.at(-1)!.segments.at(-1)!.pause_after_ms).toBe(0);
  }
});
test("plain format: markup and URLs stay literal", () => {
  const text = "# Literal heading\n- **literal item** at https://example.test";
  const result = read(text, 400, "plain");
  expect(result.plan.display_document.text).toBe(text);
  expect(result.requests.map(r => r.text)).toEqual(["# Literal heading.", "- **literal item** at https://example.test"]);
  expect(result.plan.display_document.blocks.map(b => b && typeof b === "object" && !Array.isArray(b) ? b.kind : undefined)).toEqual(["heading", "list-item"]);
  partition(result);
});
test("determinism: two calls give byte-identical results", () => {
  for (const text of fixtures) expect(JSON.stringify(read(text))).toBe(JSON.stringify(read(text)));
});
test("empty and whitespace-only input throws typed errors", () => {
  for (const text of ["", " \r\n\t", "---", "[ref]: https://example.test"]) expect(() => read(text)).toThrow(ReadPlanError);
});

test("chunk disagreement throws before a plan escapes", () => {
  const original = cutter.planSynthesisUnits;
  const spy = spyOn(cutter, "planSynthesisUnits").mockImplementation(args => {
    const pieces = original(args);
    pieces[0].segments[0].text = "Changed ripe apples.";
    return pieces;
  });
  try { expect(() => read("Gather ripe apples.")).toThrow("CHUNK_MISMATCH"); }
  finally { spy.mockRestore(); }
});

test("retained numeric and version spans use document words across request boundaries", () => {
  for (const number of ["-1", "1.2"]) {
    const result = read(`\`${number} aa/bb c d e f\``, number === "-1" ? 11 : 12);
    expect(result.plan.words.map(word => word.text)).toEqual([`\`${number}`, "aa/bb", "c", "d", "e", "f`"]);
    expect(result.requests.map(request => request.text)).toEqual([`\`${number} aa/bb c`, "d e f`"]);
    expect(result.plan.pieces.map(piece => [piece.word_start, piece.word_end])).toEqual([[0, 3], [3, 6]]);
    partition(result);
  }
});

test("sentence boundaries preserve whitespace chunks in valid reads", () => {
  for (const text of ["?z", "See https://example.test/fruit?q=plums for details.",
    "Run `curl example.test/c?d=e` once.", "Wash green apples!Then dry them.", "Ask “Set?”Then start.",
    "Fruit ripens._\n\nLeaves fall.", "猫は寝ます。犬は走ります。", "`\n \nleaf`", "Use `fresh\n \nfruit` here."]) {
    for (const format of ["plain", "markdown"] satisfies ("plain" | "markdown")[]) partition(read(text, 11, format));
  }
  expect(read("猫は寝ます。犬は走ります。", 1).requests).toHaveLength(1);
});
test("cutter errors are typed and retain their cause", () => {
  try { read("Green apples grow.", 0); throw new Error("expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(ReadPlanError); if (error instanceof ReadPlanError) {
    expect(error.code).toBe("CUTTER_REJECTED"); expect(error.cause).toBeInstanceOf(RangeError);
  } }
});
test("pause placement follows blank lines and directly following headings", () => {
  for (const [text, expected] of [
    ["# Fruit\n\nTail.", [1000, 0]], ["- Green pear\n\nTail.", [1000, 0]],
    ["Fruit grows.\n# Tree\nTail.", [600, 900, 0]], ["Fruit grows.\n- Green pear\nTail.", [550, 450, 0]],
    ["| Fruit | Color |\n|---|---|\n| Plum | Purple |\nTail.", [550, 550, 0]],
    ["Before.\n```ts\nconst fruit = 3;\n```\nAfter.", [550, 0, 0]],
  ] satisfies [string, number[]][]) expect(read(text).plan.pieces.map(p => p.segments[0].pause_after_ms)).toEqual(expected);
});
test("heading levels pin 900 750 and 800 pauses", () => {
  expect(read("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\nTail.").plan.pieces
    .map(p => p.segments[0].pause_after_ms)).toEqual([900, 750, 750, 800, 800, 800, 0]);
});
test("task marker is excluded from the item length threshold", () => {
  expect(read("- [x] wash four green apples today\nTail.").plan.pieces[0].segments[0].pause_after_ms).toBe(450);
});
test("plain structure maps exactly onto identity speech", () => {
  const text = "# Literal tree\n\n- Green pear\nTail.";
  const result = read(text, 400, "plain"); partition(result);
  expect(result.plan.display_document.text).toBe(text);
  expect(result.plan.pieces.map(p => p.segments[0].kind)).toEqual(["heading", "item", "sentence"]);
  expect(result.plan.pieces.map(p => p.segments[0].pause_after_ms)).toEqual([1000, 450, 0]);
});
test("whole read display uses VoiceLayer's 400 character budget", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} grows green apples.\n`).join("\n");
  const projection = projectStructuredSpeech(text);
  expect(JSON.stringify(read(text).plan.display_document)).toBe(JSON.stringify(structuredReadDisplay(projection, [projection.speechText], 400)[0]));
});
for (const side of ["start", "end"]) test(`coverage check refuses a missing ${side} unit`, () => {
  const original = cutter.planSynthesisUnits;
  const spy = spyOn(cutter, "planSynthesisUnits").mockImplementation(args => {
    const pieces = original(args); return side === "start" ? pieces.slice(1) : pieces.slice(0, -1);
  });
  try { expect(() => read("Green fruit grows. Bright flowers bloom.")).toThrow("CHUNK_MISMATCH"); }
  finally { spy.mockRestore(); }
});
test("plan identity and engine pick only declared fields", () => {
  const widerIdentity = { ...identity, type: "alien", extra: "discard" }, widerEngine = { ...engine, extra: "discard" };
  const result = read("Green fruit grows.", 60, "markdown", false, { identity: widerIdentity, engine: widerEngine });
  expect(result.plan.type).toBe("plan"); expect(result.plan).not.toHaveProperty("extra"); expect(result.plan.engine).toEqual(engine);
});

test("pause parity: VoiceLayer reference boundaries on invented documents", () => {
  expect(pauseFixtures.length).toBeGreaterThanOrEqual(40);
  for (const fixture of pauseFixtures) {
    const result = read(fixture.text, 100000, fixture.format === "plain" ? "plain" : "markdown");
    if ("word_pauses" in fixture && fixture.word_pauses) {
      // The oracle may include extra zero-pause budget cuts. Compare their union.
      const expected = new Map(fixture.word_pauses.map(([at, pause]) => [at, pause]));
      // Category 4: the contract keeps sentence units where VL packs prose.
      if ("contract_sentence_ends" in fixture) for (const at of fixture.contract_sentence_ends ?? []) expected.set(at, 550);
      const actual = new Map(result.plan.pieces.map(piece => [piece.word_end, piece.segments[0].pause_after_ms]));
      for (const at of new Set([...expected.keys(), ...actual.keys()])) expect(actual.get(at) ?? 0).toBe(expected.get(at) ?? 0);
    } else expect(result.plan.pieces.map(piece => piece.segments[0].pause_after_ms)).toEqual(fixture.pauses);
    expect(result.requests.every(request => /[\p{L}\p{N}]/u.test(request.text))).toBe(true);
    partition(result);
  }
  const bold = read("**Branches**\nLeaves.");
  expect(bold.plan.pieces[0].segments[0].kind).toBe("heading");
  expect(bold.requests[0].text).toBe("Branches.");
  expect(bold.plan.display_document.text).toBe("Branches\nLeaves.");
  expect(read("# Branches:\nLeaves.").requests[0].text).toBe("Branches.");
  expect(read("# Branches!\nLeaves.").requests[0].text).toBe("Branches!");
});

test("wordless heading-only text uses the neighbourless prose fallback", () => {
  const result = read("# :");
  expect(result.requests.map(request => request.text)).toEqual([":"]);
  expect(result.plan.pieces[0].segments[0].kind).toBe("sentence");
  partition(result);
});

const wordlessShapes = {
'bold-after-blank':'Pears fall.\n\n**Grove**\nTail.', 'bold-after-prose-line':'Pears fall\n**Grove**\nTail.',
'bold-ending-colon':'**Grove:**\nTail.', 'bold-ending-q-bang':'**Grove!**\nTail.', 'bold-hebrew-cjk':'**森林**\nעלה.',
'bold-in-item':'- **Grove**\nTail.', 'bold-in-quote':'> **Grove**\nTail.', 'bold-in-table':'| **Grove** | Leaf |\n| --- | --- |\n| Pear | Green |',
'bold-indented':'  **Grove**\nTail.', 'bold-indented-continuation':'**Grove**\n\t**Branch**\nTail.',
'bold-initial':'**Grove**\nTail.', 'bold-then-list':'**Grove**\n- Leaf\n- Fruit', 'bold-trailing-text':'**Grove** rises\nTail.',
'bold-two-in-row':'**Grove**\n**Branch**\nTail.', 'bold-word-sentence':'**Grove.**', 'bold-wordless':'**—**\nPears fall.',
'colon-code':'Gather:\n```\nleaf\n```\nTail.', 'colon-list-blank':'Gather:\n\n- Leaf\nTail.', 'colon-list-direct':'Gather:\n- Leaf\nTail.',
'colon-nested-list':'Gather:\n- Leaf\n  - Fruit\nTail.', 'colon-ordered':'Gather:\n1. Leaf\n2. Fruit\nTail.',
'colon-paragraph':'Gather:\n\nPears fall. Tail.', 'heading-ending':'# Grove!\nTail.', 'heading-hebrew-cjk':'# עץ\n月亮升起。',
'heading-last':'Pears fall.\n# Grove', 'heading-punct-only':'# ?!\nTail.', 'italic-line':'*Grove*\nTail.',
'paragraph-multi':'Pears fall. Leaves rise. Tail.', 'setext-ending':'Grove\n=====\nTail.', 'underscore-initial':'__Grove__\nTail.',
'unterm-at-end':'Pears fall.\nTail', 'unterm-before-blank':'Pears fall\n\nTail.', 'unterm-before-heading':'Pears fall\n# Grove\nTail.',
'unterm-before-list':'Pears fall\n- Leaf\nTail.', 'unterm-midpara':'Pears fall\nLeaves rise. Tail.',
'first':'**·**\nTail.', 'last':'Pears fall.\n**·**', 'between-headings':'# Grove\n**·**\n## Branch\nTail.',
'between-items':'- Leaf\n- -\n- Fruit', 'after-blank':'Pears fall.\n\n**·**\nTail.',
'before-table':'**·**\n| Leaf | Fruit |\n| --- | --- |\n| Pear | Green |', 'before-code':'**·**\n```\nleaf\n```',
'two-in-row':'Pears fall.\n**·**\n## ?!\nTail.', 'three-in-row':'Pears fall.\n**·**\n## ?!\n**—**\nTail.',
'leading-chain':'**·**\n## ?!\nTail.', 'trailing-chain':'Pears fall.\n**·**\n## ?!', 'only-content':'**·**\n## ?!',
'wordless-indented':'  **·**\n\t**Grove**\nTail.', 'hebrew-cjk-neighbours':'# עץ\n**·**\n月亮升起。',
'after-colon':'Gather:\n**·**\n- Leaf', 'after-prose':'Pears fall\n**·**\nTail.',
'after-bold':'**Grove**\n!!\nTail.', 'after-blank-bold':'Pears fall.\n\n**Grove**\n—\n\nTail.',
'rule':'Pears fall.\n\n---\n\nTail.', 'table':'| Leaf | Fruit |\n| --- | --- |\n| Pear | Green |',
'backtick':'Pears fall.\n`\nTail.', 'wordless-item':'Pears fall.\n- -\nTail.', 'after-terminal':'Pears fall.\n!!',
};

test("no engine request without a word: seeded prose, headings, lists, rules and tables", () => {
  let seed = 6503, failures = 0, documents = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const base of Object.values(wordlessShapes)) for (let i = 0; i < 60; i++) {
    const text = base.replaceAll("!!", ["`", "***", "—", "…", "!!", "?!", "·", "- -"][i % 8]).replaceAll("Grove", ["Grove", "עץ", "森林"][random() % 3])
      .replaceAll("**·**", ["**·**", "**—**", "**!!**", "**…**"][random() % 4]);
    const result = read(text, [8, 14, 40, 100000][i % 4], i % 2 ? "plain" : "markdown");
    if (/[\p{L}\p{N}]/u.test(result.plan.display_document.text)) {
      documents++;
      failures += result.requests.filter(request => !/[\p{L}\p{N}]/u.test(request.text)).length;
    }
  }
  expect(documents).toBeGreaterThanOrEqual(3000);
  expect(failures).toBe(0);
});

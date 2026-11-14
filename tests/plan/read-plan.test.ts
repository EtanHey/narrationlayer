import { expect, test, spyOn } from "bun:test";
import { planRead, ReadPlanError } from "../../src/plan/read-plan";
import { displayTokens } from "../../src/text/voicelayer/display-tokens";
import { parseEvent, parseRequest } from "../../src/engine/messages/parser";

import * as cutter from "../../src/plan/synthesis-units";

const engine = { family: "edge", profile_revision: "fixture-v1", voice: "synthetic" };
const identity = { session_id: "session-fixture", attempt_id: "attempt-fixture" };
function read(text: string, max_chars = 60, format: "plain" | "markdown" = "markdown", first_piece_raw = false) {
  const request = parseRequest({ protocol: "nl.engine/1", type: "narrate", request_id: "req-fixture",
    idempotency_key: "fixture", use: "read", input: { text, format },
    voice: { profile: "fixture", require_clone: false, fallback: "none" }, delivery: "pieces" });
  if (!request.ok || request.value.type !== "narrate") throw new Error("fixture request");
  return planRead({ request: request.value, limits: { max_chars: { read: max_chars, speak: 80, ask_prompt: 90 },
    lookahead: 1, aligner_reap_ms: 100 }, identity, engine, first_piece_raw });
}
const shapes = "# Orchard notes\n\n- Apples\n- Gather ripe pears\n- Gather six ripe pears for breakfast\n- Label: keep these ripe apples safely.\n- Run `fruit_check` before storing apples.\n- Visit [the orchard](https://example.test) before dawn.\n- Visit https://example.test before dawn.\n\nThese green apples grow beside the wall, these golden pears grow beside the gate, and those plums grow near the river.";
const fixtures = [shapes, "| Fruit | Color |\n| --- | --- |\n| Pear | Green |",
  "Before the example.\n```ts\nconst fruit = 2;\n```\nAfter the example.",
  "> Watch **bright** stars and _quiet_ clouds.", "- Parent fruit\n  - Child fruit\n  - More child fruit",
  "2. Gather ripe pears\n3. Wash ripe apples", "# שלום 😀\n\nהעץ ירוק מאוד. השמש זורחת היום.",
  "Title\n=====\n\nOther\n-----\n\nPick client/server.\nWrap   soft\nlines carefully.",
  "# One\n---\n\n## Two\n\n### Three\n\n#### Four\n\nTail sentence."];
function partition(result: ReturnType<typeof read>) {
  const { plan, requests } = result;
  let cursor = 0;
  plan.pieces.forEach((piece, index) => {
    expect(piece.index).toBe(index);
    expect(piece.word_start).toBe(cursor);
    for (const segment of piece.segments) {
      expect(segment.word_start).toBe(cursor);
      const tokens = displayTokens(requests[index].text).map(token => token[0]);
      expect(plan.words.slice(segment.word_start, segment.word_end).map(word => word.text)).toEqual(tokens);
      cursor = segment.word_end;
    }
    expect(piece.word_end).toBe(cursor);
  });
  expect(cursor).toBe(plan.words.length);
}

test("partition: every document word belongs to exactly one segment and piece", () => {
  for (const text of fixtures) for (const cap of [14, 60, 400]) partition(read(text, cap));
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
  expect(read("# Bud\n\nOne two three four five.", 14).requests.map(r => r.text)).toEqual(["Bud", "One two three four five."]);
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
  expect(requests.slice(0, 8).map(r => r.text)).toEqual(["Orchard notes", "Apples.", "Gather ripe pears.",
    "Gather six ripe pears for breakfast.", "Label: keep these ripe apples safely.", "Run fruit_check before storing apples.",
    "Visit the orchard before dawn.", "Visit link before dawn."]);
  expect(requests.length).toBeGreaterThan(9);
  expect(plan.pieces.slice(1, 8).every(piece => piece.segments[0].kind === "item")).toBe(true);
  expect(requests.slice(8, -1).every(r => /[,;:—–-]$/.test(r.text))).toBe(true);
});
test("PAUSE-PL-01: authored pauses have one owner; raw piece zero moves its pause", () => {
  for (const raw of [false, true]) {
    const { plan } = read("# Orchard\n\n- Pick ripe pears\n- Pick six ripe pears for breakfast\n\nFirst sentence grows. Next sentence flowers.\n\nTail grows here.", 400, "markdown", raw);
    expect(plan.pieces.flatMap(p => p.segments.map(s => s.pause_after_ms))).toEqual([900, 450, 700, 550, 1000, 0]);
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
  expect(result.requests.map(r => r.text).join(" ")).toBe(text.replace(/\n/g, " "));
  expect(result.plan.display_document.blocks.map(b => b && typeof b === "object" && !Array.isArray(b) ? b.kind : undefined)).toEqual(["paragraph"]);
  partition(result);
});
test("determinism: two calls give byte-identical results", () => {
  for (const text of fixtures) expect(JSON.stringify(read(text))).toBe(JSON.stringify(read(text)));
});
test("empty and whitespace-only input throws typed errors", () => {
  for (const text of ["", " \r\n\t", "---", "[ref]: https://example.test"]) expect(() => read(text)).toThrow(ReadPlanError);
});

test("token disagreement throws before a plan escapes", () => {
  const original = cutter.planSynthesisUnits;
  const spy = spyOn(cutter, "planSynthesisUnits").mockImplementation(args => {
    const pieces = original(args);
    pieces[0].segments[0].text = "Changed ripe apples.";
    return pieces;
  });
  try { expect(() => read("Gather ripe apples.")).toThrow("TOKEN_MISMATCH"); }
  finally { spy.mockRestore(); }
});

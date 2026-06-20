import { expect, test } from "bun:test";

import { normalizeForSpeech } from "../src/text-normalize.js";

// --- Explicit term map (acronyms / specific words) ---

test("pgid is spoken letter-by-letter", () => {
  expect(normalizeForSpeech("Check the pgid before killing.")).toBe(
    "Check the P G I D before killing.",
  );
});

test("tty is spoken letter-by-letter", () => {
  expect(normalizeForSpeech("Attach to the tty now.")).toBe(
    "Attach to the T T Y now.",
  );
});

test("tty-input expands to T T Y input", () => {
  expect(normalizeForSpeech("The tty-input is buffered.")).toBe(
    "The T T Y input is buffered.",
  );
});

test("cmux-agents expands before cmux (longest match first)", () => {
  expect(normalizeForSpeech("Spawn cmux-agents in cmux.")).toBe(
    "Spawn see mux agents in see mux.",
  );
});

test("cmux expands to see mux", () => {
  expect(normalizeForSpeech("Open cmux.")).toBe("Open see mux.");
});

test("triage expands to tree azh", () => {
  expect(normalizeForSpeech("Time to triage the queue.")).toBe(
    "Time to tree azh the queue.",
  );
});

// --- General rules ---

test("dotted lowercase identifier becomes spaced 'dot'", () => {
  expect(normalizeForSpeech("Call surface.select.split here.")).toBe(
    "Call surface dot select dot split here.",
  );
});

test("snake_case identifier becomes spaced words", () => {
  expect(normalizeForSpeech("Run spawn_agent now.")).toBe(
    "Run spawn agent now.",
  );
});

test("leading @word becomes 'at word'", () => {
  expect(normalizeForSpeech("Ping @narration please.")).toBe(
    "Ping at narration please.",
  );
});

test("at before @word is not duplicated", () => {
  expect(normalizeForSpeech("Look at @narration please.")).toBe(
    "Look at narration please.",
  );
});

test("@-tag becomes 'at tag'", () => {
  expect(normalizeForSpeech("Use the @-tag syntax.")).toBe(
    "Use the at tag syntax.",
  );
});

test("at before @-tag is not duplicated", () => {
  expect(normalizeForSpeech("Look at @-tag syntax.")).toBe(
    "Look at tag syntax.",
  );
});

test("x-vs-y becomes x versus y (specific human-vs-agent)", () => {
  expect(normalizeForSpeech("This is human-vs-agent work.")).toBe(
    "This is human versus agent work.",
  );
});

test("generic x-vs-y becomes versus", () => {
  expect(normalizeForSpeech("It's red-vs-blue today.")).toBe(
    "It's red versus blue today.",
  );
});

// --- Case-insensitivity ---

test("replacements are case-insensitive", () => {
  expect(normalizeForSpeech("PGID and Cmux and TRIAGE")).toBe(
    "P G I D and see mux and tree azh",
  );
});

// --- Must-not-mangle guards ---

test("ordinary prose is unchanged", () => {
  const prose = "The quick brown fox jumps over the lazy dog.";
  expect(normalizeForSpeech(prose)).toBe(prose);
});

test("words containing an acronym substring are not mangled", () => {
  // "category" contains no standalone token to replace; must stay intact.
  expect(normalizeForSpeech("Pick a category and a subcategory.")).toBe(
    "Pick a category and a subcategory.",
  );
});

test("'attention' is not touched by the @ rule", () => {
  expect(normalizeForSpeech("Pay attention to this.")).toBe(
    "Pay attention to this.",
  );
});

test("'Statton' is left untouched", () => {
  expect(normalizeForSpeech("Statton arrived early.")).toBe(
    "Statton arrived early.",
  );
});

test("email-like @ inside a word is not treated as a leading @-tag", () => {
  // No leading @, so the address stays as written.
  expect(normalizeForSpeech("Mail me at user@example today.")).toBe(
    "Mail me at user@example today.",
  );
});

test("empty string returns empty string", () => {
  expect(normalizeForSpeech("")).toBe("");
});

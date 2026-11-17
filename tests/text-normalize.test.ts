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

// --- Tech-term respellings ---

test("Supabase is respelled phonetically", () => {
  expect(normalizeForSpeech("We use Supabase for auth.")).toBe(
    "We use sooper base for auth.",
  );
});

test("Twilio is respelled phonetically", () => {
  expect(normalizeForSpeech("Twilio sends the SMS.")).toBe(
    "twi lee oh sends the SMS.",
  );
});

test("LiveKit is respelled phonetically", () => {
  expect(normalizeForSpeech("LiveKit handles the WebRTC.")).toBe(
    "live kit handles the WebRTC.",
  );
});

test("Postgres is respelled phonetically", () => {
  expect(normalizeForSpeech("Store it in Postgres.")).toBe(
    "Store it in post gres.",
  );
});

test("Next.js is respelled and not split into 'next dot js'", () => {
  expect(normalizeForSpeech("Built with Next.js today.")).toBe(
    "Built with next jay ess today.",
  );
});

test("OTP is spoken letter-by-letter", () => {
  expect(normalizeForSpeech("Send them the OTP code.")).toBe(
    "Send them the O T P code.",
  );
});

test("tech-term respellings are case-insensitive", () => {
  expect(
    normalizeForSpeech("SUPABASE and twilio and LIVEKIT and postgres"),
  ).toBe("sooper base and twi lee oh and live kit and post gres");
});

test("tech terms as substrings of larger tokens are untouched", () => {
  // word-boundaried: "supabased", "postgresql", "twilioApi" must stay intact.
  expect(
    normalizeForSpeech("The supabased postgresql twilioApi stay intact."),
  ).toBe("The supabased postgresql twilioApi stay intact.");
});

test("OTP as a substring of a larger token is untouched", () => {
  expect(normalizeForSpeech("The OTPgenerator and notOTP stay intact.")).toBe(
    "The OTPgenerator and notOTP stay intact.",
  );
});

// --- General rules ---

test("dotted lowercase identifier becomes spaced 'dot'", () => {
  expect(normalizeForSpeech("Call surface.select.split here.")).toBe(
    "Call surface dot select dot split here.",
  );
});

test("dotted lowercase identifier before sentence period becomes spaced 'dot'", () => {
  expect(normalizeForSpeech("Call surface.select.split.")).toBe(
    "Call surface dot select dot split.",
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

test("legacy preparation skips spoken forms while preserving other normalization", async () => {
  const { normalizeLegacy } = await import("../src/text-normalize.js");
  expect(normalizeLegacy("Meet at 9pm: PR #123, e.g. ~5% on foo_bar.")).toBe("Meet at 9pm: PR #123, e dot g. ~5% on foo bar.");
  expect(normalizeLegacy("P R and Q A", [{ term: "PR", spoken: "pull request" }, { term: "QA", spoken: "quality assurance" }])).toBe("pull request and quality assurance");
  expect(normalizeLegacy("P\nR")).toBe("P\nR");
  expect(normalizeForSpeech("P R and Q A")).toBe("P R and Q A");
});

test("initialism speech aliases retain the authored multiword phrase", async () => {
  const { deriveSpeechAliases } = await import("../src/text-normalize.js");
  expect(deriveSpeechAliases("Read P R now", "Read pull request now")).toContainEqual({ term: "P R", spoken: "pull request" });
});

test("shadcn is respelled for synthesis while authored display text is retained", async () => {
  const { prepareSpeechChannels, deriveSpeechAliases } = await import("../src/text-normalize.js");
  const display = "Our paper robot uses ShAdCn beside a silver notebook.";
  const channels = prepareSpeechChannels(display);
  expect(channels.displayText).toBe(display);
  expect(channels.synthInput).toBe("Our paper robot uses shad C N beside a silver notebook.");
  expect(deriveSpeechAliases(display, channels.synthInput)).toContainEqual({ term: "ShAdCn", spoken: "shad C N" });
});

test("shadcn respelling is bounded and supports the UI library spelling", () => {
  expect(normalizeForSpeech("Try SHADCN/UI with shadcn, then shadcnish and preshadcn."))
    .toBe("Try shad C N U I with shad C N, then shadcnish and preshadcn.");
});

test("shadcn/ui has a speech alias that keeps the following word aligned", async () => {
  const { prepareSpeechChannels, deriveSpeechAliases } = await import("../src/text-normalize.js");
  const { normalizeWordTimingsForScript } = await import("../src/word-timing-repair.js");
  const display = "Try shadcn/ui today now.";
  const spoken = prepareSpeechChannels(display).synthInput;
  const aliases = deriveSpeechAliases(display, spoken);
  expect(aliases).toContainEqual({ term: "shadcn/ui", spoken: "shad C N U I" });
  const words = spoken.split(/\s+/).map((word, i) => ({ index: i, word, start: i * 0.3, end: i * 0.3 + 0.25 }));
  const repaired = normalizeWordTimingsForScript(display, words, 2.4, aliases);
  expect(repaired.words.find(word => word.word === "today")?.start).toBeCloseTo(1.8);
});

test("shadcn domains retain spoken dots after respelling", () => {
  expect(normalizeForSpeech("Visit shadcn.com and ui.shadcn.com today."))
    .toBe("Visit shad C N dot com and ui dot shad C N dot com today.");
  expect(normalizeForSpeech("https://ui.shadcn.com/docs"))
    .toBe("https://ui dot shad C N dot com/docs");
});

test("runner word check regression guard accepts the respelled synthesis text", async () => {
  const { prepareSpeechChannels } = await import("../src/text-normalize.js");
  const { wordMismatches } = await import("../src/quality/take-checks.js");
  const display = "Our tiny robot uses shadcn today.";
  const spoken = prepareSpeechChannels(display).synthInput;
  const words = "Our tiny robot uses shad C N today.".split(/\s+/)
    .map((word, i) => ({ word, start: i * 0.2, end: (i + 1) * 0.2 }));
  expect(wordMismatches(spoken, words, { setting: "a" }).pass).toBe(true);
  // A different pronunciation must still fail the same word check.
  const wrong = words.map(w => ({ ...w, word: w.word === "shad" ? "shadgeny" : w.word }));
  expect(wordMismatches(spoken, wrong, { setting: "a" }).pass).toBe(false);
});

test("shadcn normalization changes the frozen-take cache identity", async () => {
  const { computeContentHashKey } = await import("../src/pipelines/local-tts/take-cache.js");
  const display = "A wooden robot uses shadcn today.";
  const identity = { referenceClip: "/invented/reference.wav", referenceText: "Silver lanterns glow.", params: {} };
  expect(computeContentHashKey({ ...identity, spokenText: normalizeForSpeech(display) }))
    .not.toBe(computeContentHashKey({ ...identity, spokenText: display }));
});


test("explicit pronunciation hints preserve display and override only marked occurrences", async () => {
  const { prepareSpeechChannels, deriveSpeechAliases } = await import("../src/text-normalize.js");
  const marked = "The checks live{say:liv} here. We go live tomorrow. Every read{say:reed} costs.";
  const channels = prepareSpeechChannels(marked);
  expect(channels.displayText).toBe("The checks live here. We go live tomorrow. Every read costs.");
  expect(channels.synthInput).toBe("The checks liv here. We go live tomorrow. Every reed costs.");
  expect(normalizeForSpeech(marked)).toBe(channels.synthInput);
  expect(deriveSpeechAliases(channels.displayText, channels.synthInput)).toEqual([
    { term: "live", spoken: "liv" }, { term: "read", spoken: "reed" },
  ]);
  expect(prepareSpeechChannels("We live here and read daily.").displayText).toBe("We live here and read daily.");
  expect(prepareSpeechChannels("cmux{say:mux}").synthInput).toBe("mux");
});

test("pronunciation hint aliases anchor displayed words to spoken timings and word checks", async () => {
  const { prepareSpeechChannels, prepareWordCheckText, deriveSpeechAliases } = await import("../src/text-normalize.js");
  const { normalizeWordTimingsForScript } = await import("../src/word-timing-repair.js");
  const { wordMismatches } = await import("../src/quality/take-checks.js");
  const channels = prepareSpeechChannels("We live{say:liv} here and read{say:reed} daily.");
  const words = channels.synthInput.split(/\s+/).map((word, index) => ({index, word, start: index * .5, end: index * .5 + .4}));
  const aligned = normalizeWordTimingsForScript(channels.displayText, words, 3, deriveSpeechAliases(channels.displayText, channels.synthInput));
  expect(aligned.words.map(w => w.word)).toEqual(["We", "live", "here", "and", "read", "daily."]);
  expect(aligned.words[1].start).toBe(.5);
  expect(aligned.words[4].start).toBe(2);
  const expected = prepareWordCheckText("We live{say:liv} here and read{say:reed} daily.", channels.synthInput,
    text => prepareSpeechChannels(text).synthInput);
  const recognised = words.map(word => ({ ...word, word: word.word === "liv" ? "live" : word.word === "reed" ? "read" : word.word }));
  expect(wordMismatches(expected, recognised, {setting: "a"}).pass).toBe(true);
  expect(wordMismatches(expected, recognised.map(word => ({ ...word, word: word.word === "live" ? "sleep" : word.word })), {setting: "a"}).pass).toBe(false);
});

test("malformed or misplaced reserved hints fail before displaying or speaking markup", async () => {
  const { prepareSpeechChannels } = await import("../src/text-normalize.js");
  for (const text of ["live{say:}", "live{say:liv", "live{say liv}", "live{SAY:liv}", "live{ say:liv}", "live{say:two words}", "live {say:liv}", "{say:liv}", "live{say:liv}tail", "live{say:liv}{say:laiv}", "live{say:{liv}}", "`live{say:liv}`"]) {
    expect(() => prepareSpeechChannels(text)).toThrow("Invalid pronunciation hint");
    expect(() => normalizeForSpeech(text)).toThrow("Invalid pronunciation hint");
  }
});


test("adjacent hints retain individual timing aliases and distinct cache keys", async () => {
  const { prepareSpeechChannels, deriveSpeechAliases } = await import("../src/text-normalize.js");
  const { computeContentHashKey } = await import("../src/pipelines/local-tts/take-cache.js");
  const channels = prepareSpeechChannels("live{say:liv} read{say:reed}");
  expect(deriveSpeechAliases(channels.displayText, channels.synthInput)).toEqual([
    { term: "live", spoken: "liv" }, { term: "read", spoken: "reed" },
  ]);
  const identity = { referenceClip: "/invented/reference.wav", referenceText: "Silver lanterns glow.", params: {} };
  expect(computeContentHashKey({ ...identity, spokenText: channels.synthInput }))
    .not.toBe(computeContentHashKey({ ...identity, spokenText: channels.displayText }));
});


test("timing tokenization hides hints for fake and external-command renderers", async () => {
  const { getWordsFromScript } = await import("../src/timing/script-words.js");
  expect(getWordsFromScript("We live{say:liv} here.")).toEqual(["We", "live", "here."]);
  expect(() => getWordsFromScript("We live{say:} here.")).toThrow("Invalid pronunciation hint");
});

test("hint word checks keep unhinted normalization and persisted custom expectations", async () => {
  const { prepareWordCheckText, prepareSpeechChannels } = await import("../src/text-normalize.js");
  const text = "We live{say:liv} and read{say:reed} with shadcn.";
  const spoken = prepareSpeechChannels(text).synthInput;
  expect(prepareWordCheckText(text, spoken, fragment => prepareSpeechChannels(fragment).synthInput))
    .toBe("We live and read with shad C N.");
  expect(prepareWordCheckText("Unmarked source.", "Custom persisted synthesis.", () => {
    throw new Error("Unmarked takes must use persisted synthesis without re-preparing");
  })).toBe("Custom persisted synthesis.");
});

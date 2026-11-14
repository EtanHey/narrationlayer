import { expect, test } from "bun:test";
import { selectVoice, VoiceUnavailable, type Voices } from "../../../src/engine/selection/voice";
import type { Message } from "../../../src/engine/messages/messages";
const voices: Voices = { profiles: { lantern: { kind: "clone", revision: "c1", fallback_voice: "stock-fallback" }, meadow: { kind: "preset", revision: "p1", voice: "en-US-AriaNeural" }, river: { kind: "preset", revision: "p2", voice: "fr-FR-DeniseNeural" } }, default_voice: "stock-default", hebrew_voice: "he-IL-HilaNeural" };
const engines: Message<"welcome">["engines"] = [{ family: "qwen3_clone", available: true, legacy: false, clone: true, timing: "none", cancel: "abort_only" }];
function choose(profile: string, mode: Message<"narrate">["mode"] = "brief", require_clone = false, text = "Amber", caps = engines, table = voices) {
  return selectVoice({ use: "speak", mode, voice: { profile, require_clone, fallback: "none" } }, text, text.length, table, caps);
}
test("row 1: missing mandated clone refuses", () => expect(() => choose("missing", "brief", true)).toThrow(VoiceUnavailable));
test("row 2: missing profile substitutes under both fallback values", () => {
  for (const fallback of ["none", "declared"] as const) expect(selectVoice({ use: "read", voice: { profile: "missing", require_clone: false, fallback } }, "Amber", 5, voices, engines)).toMatchObject({ engine: { voice: "stock-default" }, substituted: true, fallback_reason: "clone_profile_missing" });
});
test("row 3: unavailable and absent mandated clone refuse", () => {
  for (const caps of [[], engines.map(e => ({ ...e, available: false }))]) expect(() => choose("lantern", "announce", true, "Amber", caps)).toThrow(VoiceUnavailable);
});
test("row 4: shortcut at 49, not 50; default fallback", () => {
  expect(choose("lantern", "announce", false, "a".repeat(49))).toMatchObject({ engine: { voice: "stock-fallback" }, substituted: true, fallback_reason: "announce_shortcut" });
  expect(choose("lantern", "announce", false, "a".repeat(50)).substituted).toBe(false);
  expect(choose("lantern", "announce", false, "Amber", engines, { ...voices, profiles: { lantern: { kind: "clone", revision: "c1" } } }).engine.voice).toBe("stock-default");
});
test("row 5: clone brief, converse, required announce, unavailable nonmandated", () => {
  for (const mode of ["brief", "converse", "announce"] as const) expect(choose("lantern", mode, true, "אבגד")).toEqual({ engine: { family: "qwen3_clone", voice: "lantern", profile_revision: "c1" }, substituted: false, fallback_reason: null });
  expect(choose("lantern", "brief", false, "Amber", []).engine.family).toBe("qwen3_clone");
});
test("row 6: strictly more than half Hebrew letters, English neural only", () => {
  expect(choose("meadow", "converse", false, "אבab!12").substituted).toBe(false);
  expect(choose("meadow", "converse", false, "אבגab!12")).toMatchObject({ engine: { voice: voices.hebrew_voice }, substituted: true, fallback_reason: "language_voice" });
  expect(choose("river", "converse", false, "אבג").substituted).toBe(false);
  expect(choose("lantern", "converse", false, "אבג").substituted).toBe(false);
});
test("row 7: preset identity and revision", () => expect(choose("meadow")).toEqual({ engine: { family: "edge", voice: "en-US-AriaNeural", profile_revision: "p1" }, substituted: false, fallback_reason: null }));
test("inherited property names are missing", () => {
  for (const name of ["constructor", "__proto__"]) { expect(choose(name).fallback_reason).toBe("clone_profile_missing"); expect(() => choose(name, "brief", true)).toThrow(VoiceUnavailable); }
});
test("announce read preserves the clone", () => {
  expect(selectVoice({ use: "read", mode: "announce", voice: { profile: "lantern", require_clone: false, fallback: "none" } }, "Amber", 5, voices, engines)).toMatchObject({ engine: { family: "qwen3_clone" }, substituted: false });
});

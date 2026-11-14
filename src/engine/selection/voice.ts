import { json, object, union, literal, string, opaqueString, InvalidField } from "../messages/schema";
import type { Message } from "../messages/messages";
export type Voices = {
  profiles: Record<string, { kind: "clone"; revision: string; fallback_voice?: string } | { kind: "preset"; revision: string; voice: string }>;
  default_voice: string; hebrew_voice: string;
};
const profileSchema = union(
  object({ kind: literal("clone"), revision: opaqueString }, { fallback_voice: string }),
  object({ kind: literal("preset"), revision: opaqueString, voice: opaqueString }),
);
const voicesSchema = object({ profiles: json, default_voice: opaqueString, hebrew_voice: opaqueString });
/** Parse host data once, before any request can be admitted. */
export function parseVoices(value: unknown): Voices {
  const table = voicesSchema.read(value, "voices"), profiles = table.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) throw new InvalidField("voices.profiles");
  return { ...table, profiles: Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, profileSchema.read(profile, `voices.profiles.${name}`)])) };
}
export type Substitution = { substituted: boolean; fallback_reason: string | null };
export class VoiceUnavailable extends Error {}
/** Admission policy, in contract §6 order; no host callbacks or external state. */
export function selectVoice(request: Pick<Message<"narrate">, "use" | "mode" | "voice">, display: string, speechLength: number, voices: Voices, engines: Message<"welcome">["engines"]): Substitution & { engine: Message<"plan">["engine"] } {
  const profile = Object.hasOwn(voices.profiles, request.voice.profile) ? voices.profiles[request.voice.profile] : undefined;
  const edge = (voice: string, revision: string, reason: string | null) => ({ engine: { family: "edge", voice, profile_revision: revision }, substituted: reason !== null, fallback_reason: reason });
  if (!profile) {
    if (request.voice.require_clone) throw new VoiceUnavailable();
    return edge(voices.default_voice, "default", "clone_profile_missing");
  }
  if (profile.kind === "clone") {
    if (request.voice.require_clone && !engines.some(e => e.family === "qwen3_clone" && e.available)) throw new VoiceUnavailable();
    if (request.use === "speak" && request.mode === "announce" && !request.voice.require_clone && speechLength < 50)
      return edge(profile.fallback_voice || voices.default_voice, profile.revision, "announce_shortcut");
    return { engine: { family: "qwen3_clone", voice: request.voice.profile, profile_revision: profile.revision }, substituted: false, fallback_reason: null };
  }
  const letters = [...display].filter(char => /\p{Letter}/u.test(char));
  if (request.mode === "converse" && /^en-[A-Z]{2}-.+Neural$/.test(profile.voice)
    && letters.filter(char => /\p{Script=Hebrew}/u.test(char)).length > letters.length / 2)
    return edge(voices.hebrew_voice, profile.revision, "language_voice");
  return edge(profile.voice, profile.revision, null);
}

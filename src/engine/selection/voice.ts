import type { Message } from "../messages/messages";
export type Voices = {
  profiles: Record<string, { kind: "clone"; revision: string; fallback_voice?: string } | { kind: "preset"; revision: string; voice: string }>;
  default_voice: string; hebrew_voice: string;
};
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
    if (request.mode === "announce" && !request.voice.require_clone && speechLength < 50)
      return edge(profile.fallback_voice || voices.default_voice, profile.revision, "announce_shortcut");
    return { engine: { family: "qwen3_clone", voice: request.voice.profile, profile_revision: profile.revision }, substituted: false, fallback_reason: null };
  }
  const letters = [...display].filter(char => /\p{Letter}/u.test(char));
  if (request.mode === "converse" && /^en-[A-Z]{2}-.+Neural$/.test(profile.voice)
    && letters.filter(char => /\p{Script=Hebrew}/u.test(char)).length > letters.length / 2)
    return edge(voices.hebrew_voice, profile.revision, "language_voice");
  return edge(profile.voice, profile.revision, null);
}

import type { Case } from "./runner";
import type { Message } from "../messages/messages";
import { setup } from "./engine-cases";
import { pcmAudio } from "./fake-backend";
const voices = { profiles: { lantern: { kind: "clone", revision: "clone-1", fallback_voice: "en-GB-SoniaNeural" }, meadow: { kind: "preset", revision: "preset-1", voice: "en-US-AriaNeural" } }, default_voice: "en-AU-NatashaNeural", hebrew_voice: "he-IL-HilaNeural" } as const;
const engines = (available: boolean): Message<"welcome">["engines"] => ["edge", "qwen3_clone"].map(family => ({ family: family === "edge" ? "edge" : "qwen3_clone", available: family === "edge" || available, max_chars: 120, legacy: false, clone: family !== "edge", timing: "none", cancel: "abort_only" }));
const request = (profile: string, require_clone = false, text = "Amber rafts float.", mode: Message<"narrate">["mode"] = "brief"): Message<"narrate"> => ({ protocol: "nl.engine/1", type: "narrate", request_id: "selection-request", idempotency_key: "selection-key", use: "speak", mode, voice: { profile, require_clone, fallback: "none" }, input: { text, format: "plain" }, delivery: "pieces", lookahead: 10 });
export const selectionCases: Record<string, Case> = {
  "ENG-01": async c => {
    for (const variant of ["unavailable", "missing", "absent", "available"]) {
      const positive = variant === "available";
      const t = setup(c, positive ? [{ latency_ms: 0, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(100) } }] : [], { voices, engines: variant === "absent" ? engines(true).slice(0, 1) : engines(positive) });
      t.connection.send(request(variant === "missing" ? "unknown-lantern" : "lantern", true));
      await t.settle(10); await t.finish();
      const errors = t.seen.filter(e => e.type === "error");
      if (positive) {
        c.assert(t.seen.some(e => e.type === "accepted")); // §6 L359 positive control.
        c.assert(t.seen.some(e => e.type === "plan" && e.engine.family === "qwen3_clone")); // §6 L360.
      } else {
        c.assert(errors.length === 1 && errors[0].code === "VOICE_UNAVAILABLE" && errors[0].phase === "admit" && errors[0].retry === "new_request" && errors[0].request_id === "selection-request"); // L219, L359; Q67 absent/unavailable.
        c.assert(!t.seen.some(e => ["accepted", "plan", "piece_ready", "outcome"].includes(e.type))); // ENG-01 L541: fails closed at admission.
        c.assert(t.backend.calls.length === 0); // ENG-01 L541: no Edge audio, even after time advances.
      }
    }
  },
  "SUB-01": async c => {
    const rows = [
      ["lantern", "announce", "Amber rafts float. Violet cranes glide.", "en-GB-SoniaNeural", true],
      ["meadow", "converse", "סירות ענבר צפות. עגורים סגולים עפים.", voices.hebrew_voice, true],
      ["unknown-lantern", "brief", "Amber rafts float. Violet cranes glide.", voices.default_voice, true],
      ["lantern", "announce", "a".repeat(50), "lantern", false],
      ["lantern", "brief", "Amber rafts float.", "lantern", false],
      ["meadow", "brief", "סירות ענבר צפות.", "en-US-AriaNeural", false],
      ["meadow", "brief", "Amber rafts float.", "en-US-AriaNeural", false],
    ] as const;
    for (const [profile, mode, text, voice, substituted] of rows) {
      // One piece per sentence for these fixtures; max_chars never truncates a word.
      const count = text.includes(". ") ? 2 : 1;
      const t = setup(c, Array.from({ length: count }, () => ({ latency_ms: 0, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(100, 1000, 300) } })), { voices, engines: engines(true).map(e => ({ ...e, max_chars: 1200 })) });
      t.connection.send(request(profile, false, text, mode)); for (let i = 0; i < 8; i++) await t.settle(1);
      const pieces = t.seen.filter(e => e.type === "piece_ready");
      for (const p of pieces) for (const edge of ["spawned", "first_sample", "last_sample", "exited"])
        t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: p.session_id, control_epoch: p.index + 1, player_instance_id: `selection-player-${p.index}`, piece_index: p.index, edge, t_mono_ms: c.clock.now(), source: "player_reported", ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: p.start_ms + p.duration_ms } } : {}) });
      await t.settle(); await t.finish();
      c.assert(t.seen.some(e => e.type === "outcome" && e.playback.reason === "completed" && e.generation.status === "committed")); // §2 natural completion.
      c.assert(t.seen.some(e => e.type === "plan" && e.engine.family === (substituted || profile === "meadow" ? "edge" : "qwen3_clone") && e.engine.voice === voice)); // §6 L356-358; Q65.
      c.assert(pieces.length === count && pieces.every(p => p.actual.length > 0 && p.actual.every(a => a.substituted === substituted && a.voice === voice))); // SUB-01 L544: every segment, every piece.
      c.assert(pieces.every(p => substituted ? !!p.synthesis.fallback_reason : p.synthesis.fallback_reason === null)); // SUB-01 L544.
      if (substituted) c.assert(String(voice) !== profile); // §6 substitutions name the serving voice.
      if (profile === "unknown-lantern") c.assert(pieces.every(p => p.synthesis.fallback_reason === "clone_profile_missing")); // L358; Q66: fallback none also substitutes.
    }
  },
};

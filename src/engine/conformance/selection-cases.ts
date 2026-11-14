import type { Case, CaseContext } from "./runner";
import type { Message } from "../messages/messages";
import { setup } from "./engine-cases";
import { pcmAudio } from "./fake-backend";
const voices = { profiles: { lantern: { kind: "clone", revision: "clone-1", fallback_voice: "en-GB-SoniaNeural" }, meadow: { kind: "preset", revision: "preset-1", voice: "en-US-AriaNeural" }, dune: { kind: "preset", revision: "preset-2", voice: "fr-FR-DeniseNeural" } }, default_voice: "en-AU-NatashaNeural", hebrew_voice: "he-IL-HilaNeural" } as const;
const engines = (available: boolean): Message<"welcome">["engines"] => ["edge", "qwen3_clone"].map(family => ({ family: family === "edge" ? "edge" : "qwen3_clone", available: family === "edge" || available, max_chars: 120, legacy: false, clone: family !== "edge", timing: "none", cancel: "abort_only" }));
const request = (profile: string, require_clone = false, text = "Amber rafts float.", mode: Message<"narrate">["mode"] = "brief"): Message<"narrate"> => ({ protocol: "nl.engine/1", type: "narrate", request_id: "selection-request", idempotency_key: "selection-key", use: "speak", mode, voice: { profile, require_clone, fallback: "none" }, input: { text, format: "plain" }, delivery: "pieces", lookahead: 10 });
const audio = () => ({ latency_ms: 8, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(100, 1000, 300) } } as const);
async function complete(c: CaseContext, t: ReturnType<typeof setup>, req: Message<"narrate">) {
  const start = t.seen.length;
  t.backend.script([audio()]); t.connection.send(req);
  let plan: Message<"plan"> | undefined;
  const played = new Set<number>();
  for (let tick = 0; tick < 512; tick++) {
    await t.settle(1);
    const own = t.seen.slice(start);
    if (!plan) {
      plan = own.find(e => e.type === "plan");
      if (plan) t.backend.script(Array.from({ length: plan.pieces.length - 1 }, audio));
    }
    for (const p of own.filter(e => e.type === "piece_ready")) if (!played.has(p.index)) {
      played.add(p.index);
      for (const edge of ["spawned", "first_sample", "last_sample", "exited"])
        t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: p.session_id, control_epoch: p.index + 1, player_instance_id: `selection-player-${p.index}`, piece_index: p.index, edge, t_mono_ms: c.clock.now(), source: "player_reported", ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: p.start_ms + p.duration_ms } } : {}) });
    }
    if (own.some(e => e.type === "outcome")) break;
  }
  const own = t.seen.slice(start), pieces = own.filter(e => e.type === "piece_ready");
  c.assert(own.some(e => e.type === "outcome" && e.playback.reason === "completed" && e.generation.status === "committed")); // §2 natural completion; bounded fake-clock progress, no fixed arrival tick.
  c.assert(!!plan && pieces.length === plan.pieces.length); // §1.2 L65: the engine owns grouping.
  return { plan, pieces };
}
export const selectionCases: Record<string, Case> = {
  "ENG-01": async c => {
    for (const variant of ["unavailable", "missing", "absent", "available"]) {
      const positive = variant === "available";
      const t = setup(c, positive ? [audio()] : [], { voices, engines: variant === "absent" ? engines(true).slice(0, 1) : engines(positive) });
      t.connection.send(request(variant === "missing" ? "unknown-lantern" : "lantern", true, "Amber rafts float.", "announce"));
      for (let i = 0; i < 512 && !t.seen.some(e => e.type === (positive ? "plan" : "error")); i++) await t.settle(1);
      await t.settle(128);
      await t.finish();
      const errors = t.seen.filter(e => e.type === "error");
      if (positive) {
        c.assert(t.seen.some(e => e.type === "accepted")); // §6 L359 positive control.
        c.assert(t.seen.some(e => e.type === "plan" && e.engine.family === "qwen3_clone")); // §6 L355, L359: require_clone never takes the shortcut.
      } else {
        c.assert(errors.length === 1 && errors[0].code === "VOICE_UNAVAILABLE" && errors[0].phase === "admit" && errors[0].retry === "new_request" && errors[0].request_id === "selection-request"); // L219, L359; Q67 absent/unavailable.
        c.assert(!t.seen.some(e => ["accepted", "plan", "piece_ready", "outcome"].includes(e.type))); // Q67: no session at admission.
        c.assert(t.backend.calls.length === 0); // Q67: no backend call after time advances; L541 no Edge audio.
      }
    }
  },
  "SUB-01": async c => {
    const rows = [
      ["lantern", "announce", "Amber rafts float. Violet cranes glide.", "en-GB-SoniaNeural", true],
      ["meadow", "converse", "סירות ענבר צפות. 1234567890 1234567890 1234567890 1234567890! עגורים סגולים עפים.", voices.hebrew_voice, true],
      ["unknown-lantern", "brief", "Amber rafts float. Violet cranes glide.", voices.default_voice, true],
      ["lantern", "announce", "a".repeat(50), "lantern", false],
      ["lantern", "brief", "Amber rafts float.", "lantern", false],
      ["meadow", "brief", "סירות ענבר צפות.", "en-US-AriaNeural", false],
      ["meadow", "brief", "Amber rafts float.", "en-US-AriaNeural", false],
      ["lantern", "converse", "סירות ענבר צפות.", "lantern", false],
      ["meadow", "converse", "אבab", "en-US-AriaNeural", false],
      ["dune", "converse", "סירות ענבר צפות.", "fr-FR-DeniseNeural", false],
      ["meadow", "announce", "Amber rafts float.", "en-US-AriaNeural", false],
      ["lantern", "announce", "a".repeat(48) + ".\n", "en-GB-SoniaNeural", true],
      ["lantern", "announce", "a".repeat(47) + "  b", "en-GB-SoniaNeural", true],
      ["lantern", "announce", "a".repeat(48) + "  b", "lantern", false],
      ["lantern", "announce", "[Amber rafts float.](https://example.test/" + "a".repeat(60) + ")", "en-GB-SoniaNeural", true],
    ] as const;
    // One connection, distinct ids: each later request must make its own selection (Q64).
    const t = setup(c, [], { voices, engines: engines(true) });
    for (const [i, [profile, mode, text, voice, substituted]] of rows.entries()) {
      const req = { ...request(profile, false, text, mode), request_id: `selection-${i}`, idempotency_key: `selection-${i}`, input: { text, format: i === rows.length - 1 ? "markdown" : "plain" } } satisfies Message<"narrate">;
      const { plan, pieces } = await complete(c, t, req);
      c.assert(plan?.engine.family === (substituted || profile !== "lantern" ? "edge" : "qwen3_clone") && plan.engine.voice === voice); // §6 L356-358; Q64 serving voices; Q68 announce/Hebrew substitutions also under fallback none.
      c.assert(pieces.every(p => p.actual.length > 0 && p.actual.every(a => a.substituted === substituted && a.voice === voice))); // SUB-01 L544: every segment, every piece.
      c.assert(pieces.every(p => substituted ? !!p.synthesis.fallback_reason : p.synthesis.fallback_reason === null)); // L544; Q68 fallback none.
      if (profile === "unknown-lantern") c.assert(pieces.every(p => p.synthesis.fallback_reason === "clone_profile_missing")); // L358; Q66.
    }
    const { plan, pieces } = await complete(c, t, { ...request("lantern", false, "Amber rafts float.", "announce"), use: "read", request_id: "selection-read", idempotency_key: "selection-read" });
    c.assert(plan?.engine.family === "qwen3_clone" && pieces.every(p => p.actual.every(a => !a.substituted))); // Q68 narrowed: speak only; §6 L360 long reads.
    await t.finish();
  },
};

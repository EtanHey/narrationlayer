import type { Binding } from "./binding";
import type { Message } from "../messages/messages";
import engine from "./engine-binding";

/** Consistent synthetic faults at a two-request boundary, including backend text. */
export function brokenOverLimit(rule: "space" | "pause" | "hyphen"): Binding {
  return { name: `broken-over-limit-${rule}`, create(host) {
    let texts: string[] | undefined, plan: Message<"plan"> | undefined;
    const backend = host.ports?.backend, synthesize = backend?.synthesizeRequest.bind(backend);
    if (backend && synthesize) backend.synthesizeRequest = (request, signal) => synthesize(
      texts && request && typeof request === "object" && !Array.isArray(request) && typeof request.piece_index === "number"
        ? { ...request, text: texts[request.piece_index] } : request, signal);
    const c = engine.create(host);
    return { resolve: c.resolve, shutdown: c.shutdown, send(message) {
      if (message && typeof message === "object" && !Array.isArray(message) && message.type === "narrate") texts = undefined;
      if (rule === "space" && message && typeof message === "object" && !Array.isArray(message) && message.type === "narrate") {
        const input = message.input;
        if (input && typeof input === "object" && !Array.isArray(input) && typeof input.text === "string" && /^lantern lantern lantern lantern lantern, /u.test(input.text) && input.text.endsWith("amber — tail words.")) {
          const tokens = input.text.split(/\s+/u);
          const at = tokens.map((_, i) => i).filter(i => tokens.slice(0, i).join(" ").length <= 120 && tokens.slice(i).filter(w => /[\p{L}\p{N}]/u.test(w)).length >= 3).at(-1) ?? 0;
          texts = [tokens.slice(0, at).join(" "), tokens.slice(at).join(" ")];
        }
      }
      if (rule === "hyphen" && message && typeof message === "object" && !Array.isArray(message) && message.type === "narrate") {
        const input = message.input;
        if (input && typeof input === "object" && !Array.isArray(input) && typeof input.text === "string" && /\S-\s/u.test(input.text)) {
          // Reproduce the old phrase rule, with the same three-word minimum.
          const text = input.text, candidates = [...text.matchAll(/[,;:—―–-](?=\s|$)/gu)]
            .map(m => m.index + 1).filter(at => at <= 120 && text.slice(0, at).split(/\s+/u).filter(w => /[\p{L}\p{N}]/u.test(w)).length >= 3 && text.slice(at).trim().split(/\s+/u).filter(w => /[\p{L}\p{N}]/u.test(w)).length >= 3);
          const at = candidates.at(-1);
          if (at !== undefined) texts = [text.slice(0, at), text.slice(at).trim()];
        }
      }
      c.send(message);
    }, events: (async function* () {
      for await (const e of c.events) {
        if (e.type === "plan") {
          plan = structuredClone(e);
          if (texts) {
            const at = texts[0].split(/\s+/u).length;
            plan.pieces[0].word_end = at; plan.pieces[0].segments[0].word_end = at;
            plan.pieces[1].word_start = at; plan.pieces[1].segments[0].word_start = at;
          }
          if (rule === "pause") for (let i = 0; i < plan.pieces.length - 1; i++) {
            const p = plan.pieces[i], text = plan.words.slice(p.word_start, p.word_end).map(w => w.text).join(" ");
            if (p.segments[0].kind === "sentence" && !/[.!?]$/u.test(text)) p.segments[0].pause_after_ms = 550;
          }
          yield plan; continue;
        }
        if (texts && e.type === "lifecycle" && e.edge === "synthesis_requested") { yield { ...e, chars: texts[e.piece_index].length }; continue; }
        if (texts && plan && e.type === "piece_ready") {
          const p = plan.pieces[e.index];
          yield { ...e, spoken_text: texts[e.index], words: plan.words.slice(p.word_start, p.word_end).map(w => ({ index: w.index, start_ms: 0, end_ms: 100, timing: "estimated" })) }; continue;
        }
        yield e;
      }
    })() };
  } };
}

export default brokenOverLimit("hyphen");

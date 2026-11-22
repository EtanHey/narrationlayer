import type { Binding } from "./binding";
import type { Message } from "../messages/messages";
import engine from "./engine-binding";

type Plan = Message<"plan">;
/** Synthetic stream faults; fixture gates keep each committed fail-set attributable. */
export function brokenPlanning(rule: string): Binding {
  return { name: `broken-${rule}`, create(host) {
    const connection = engine.create(host);
    let original: Plan | undefined, changed: Plan | undefined;
    let split = -1, active = false;
    return {
      resolve: connection.resolve,
      send(message) {
        if (split >= 0 && message && typeof message === "object" && !Array.isArray(message) && message.type === "player_feedback" && typeof message.piece_index === "number") {
          // A subdivided source piece completes only when its final subdivision exits.
          if (message.piece_index === split) return;
          const index = message.piece_index > split ? message.piece_index - 1 : message.piece_index;
          connection.send({ ...message, piece_index: index, control_epoch: index + 1 });
        } else connection.send(message);
      },
      shutdown: connection.shutdown,
      events: (async function* () {
        for await (const event of connection.events) {
          if (event.type === "plan") {
            original = event; changed = structuredClone(event); split = -1; active = false;
            const first = event.words[0]?.text;
            if ((rule === "PLAN-D5" && first === "Lantern") || (rule === "PLAN-01" && first === "Maple") || (rule === "PLAN-03" && first === "Gardener")) {
              active = true;
              split = rule === "PLAN-D5" ? 2 : rule === "PLAN-01" ? 3 : 4;
              const p = changed.pieces[split], at = p.word_start + (rule === "PLAN-01" ? 1 : 2);
              changed.pieces.splice(split, 1,
                { ...p, word_end: at, segments: [{ ...p.segments[0], word_end: at, pause_after_ms: 0 }] },
                { ...p, word_start: at, segments: [{ ...p.segments[0], word_start: at }] });
              changed.pieces = changed.pieces.map((p, i) => ({ ...p, index: i, piece_id: `${changed?.session_id}:fault:${i}` }));
            }
            if (rule === "PAUSE-PL-01" && first === "Meadow") {
              active = true;
              const a = changed.pieces[1].segments[0], b = changed.pieces[2].segments[0];
              [a.pause_after_ms, b.pause_after_ms] = [b.pause_after_ms, a.pause_after_ms];
            }
            yield changed; continue;
          }
          if (event.type === "piece_ready" && active && original && changed && event.session_id === original.session_id) {
            const before = original.pieces[event.index];
            for (const p of changed.pieces.filter(p => p.word_start >= before.word_start && p.word_end <= before.word_end)) {
              const joined = changed.words.slice(p.word_start, p.word_end).map(w => w.text).join(" ");
              const text = p.segments[0].kind === "heading" && joined.endsWith(":") ? joined.slice(0, -1) + "." : p.segments[0].kind !== "sentence" && !/[.!?]$/.test(joined) ? joined + "." : joined;
              yield { ...event, index: p.index, piece_id: p.piece_id, spoken_text: text, words: event.words.filter(w => w.index >= p.word_start && w.index < p.word_end) };
            }
            continue;
          }
          yield event;
        }
      })(),
    };
  } };
}

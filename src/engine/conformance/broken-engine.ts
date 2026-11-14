import type { Binding, Json } from "./binding";
import engine from "./engine-binding";
import type { Message } from "../messages/messages";

/** Each variant violates one observable rule; no variant knows the case runner. */
export function brokenEngine(rule: string): Binding {
  return { name: `broken-${rule}`, create(host) {
    const connection = engine.create(host);
    return { send: connection.send, shutdown: connection.shutdown,
      events: (async function* () {
        let held: Json | undefined, firstSession: string | undefined;
        let plan: Message<"plan"> | undefined;
        for await (const event of connection.events) {
          if (event.type === "plan") plan = event;
          if (rule === "PLAN-LAT-01" && event.type === "plan") { held = event; continue; }
          if (held && !(event.type === "outcome" && event.playback.reason === "cancel")) { yield held; held = undefined; }
          if (rule === "ERR-01" && event.type === "error" && event.code === "SYNTH_FAILED") continue;
          if (rule === "ID-04" && event.type === "accepted") { firstSession ??= event.session_id; yield { ...event, session_id: firstSession }; continue; }
          if (rule === "TIME-02" && event.type === "piece_ready") { yield { ...event, duration_ms: event.duration_ms * 3 }; continue; }
          yield event;
          if (held && event.type === "outcome") { yield held; held = undefined; }
          if (rule === "ORDER-01" && event.type === "outcome" && event.playback.reason === "completed") yield event;
          if (rule === "ID-03" && event.type === "control_ack" && plan) yield {
            protocol: "nl.engine/1", type: "piece_ready", owner_epoch: plan.owner_epoch, seq: event.seq + 1,
            session_id: plan.session_id, attempt_id: plan.attempt_id, piece_id: plan.pieces[0].piece_id, index: 0,
            start_ms: 0, duration_ms: 100, spoken_text: "Copper boats drift.", synthesis_ms: 1,
            artifact: { handle: "memory:late", lease_id: "lease:late", format: "wav", sample_count: 100, sample_rate: 1000, sha256: "0".repeat(64) },
            words: [], actual: [], synthesis: { rate: "+0%", attempts: [], unavailable: [], fallback_reason: null },
          };
        }
      })(),
    };
  } };
}

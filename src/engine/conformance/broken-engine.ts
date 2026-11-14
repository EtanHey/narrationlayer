import type { Binding, Json } from "./binding";
import engine from "./engine-binding";
import type { Message } from "../messages/messages";

/** Each variant violates one observable rule; no variant knows the case runner. */
export function brokenEngine(rule: string): Binding {
  return { name: `broken-${rule}`, create(host) {
    const connection = engine.create(host);
    return { send: connection.send, shutdown: connection.shutdown,
      events: (async function* () {
        let held: Json[] = [], firstSession: string | undefined;
        let plan: Message<"plan"> | undefined;
        for await (const event of connection.events) {
          if (event.type === "plan") plan = event;
          if (rule === "VER-01" && event.type === "welcome") { yield { ...event, protocol_minor: -1 }; continue; }
          if (event.type === "error" && ((rule === "LIM-01" && event.code === "INPUT_TOO_LONG") || (rule === "VER-02e" && event.code === "INVALID_REQUEST" && !event.request_id))) { yield { ...event, retry: "after_resync" }; continue; }
          if (event.type === "error" && ((rule === "NEG-01" && event.code === "UNSUPPORTED_VERSION") || (rule === "NEG-02" && event.code === "MISSING_CAPABILITY") || (rule === "NEG-03" && event.code === "NOT_NEGOTIATED"))) { yield { ...event, retry: "new_request" }; continue; }
          if (rule === "PLAN-LAT-01" && event.type === "plan") { held.push(event); continue; }
          if (held.length && event.type === "lifecycle") { held.push(event); continue; }
          if (held.length && !(event.type === "outcome" && event.playback.reason === "cancel")) { yield* held; held = []; }
          if (rule === "ERR-01" && event.type === "error" && event.code === "SYNTH_FAILED" && plan?.pieces.length === 1) continue;
          if (rule === "ID-04" && event.type === "accepted") { firstSession ??= event.session_id; yield { ...event, session_id: plan?.pieces.length === 1 ? firstSession : event.session_id }; continue; }
          if (rule === "TIME-02" && event.type === "piece_ready" && plan?.pieces.length === 1) { yield { ...event, duration_ms: event.duration_ms * 3 }; continue; }
          if (rule === "GEN-02" && event.type === "duration" && event.final && plan && plan.pieces.length >= 3 && event.known_ms > 100 && event.known_ms < 300) yield event;
          if (rule === "LIFE-01e" && event.type === "lifecycle" && event.edge === "audio_ready") { yield { ...event, first_audible_offset_ms: event.duration_ms + 1 }; continue; }
          if (rule === "TIME-01" && event.type === "piece_ready" && event.index > 0 && event.duration_ms === 0) { yield { ...event, start_ms: event.start_ms + 1, words: event.words.map(w => ({ ...w, start_ms: w.start_ms + 1, end_ms: w.end_ms + 1 })) }; continue; }
          if (rule === "GEN-01e" && event.type === "outcome" && event.playback.reason === "speech_failed") { yield { ...event, missing_piece_indices: [] }; continue; }
          if (rule === "WORD-02" && event.type === "piece_ready" && event.duration_ms >= 100 && plan?.pieces.length === 3) { yield { ...event, words: event.words.map(w => ({ ...w, timing: "measured" })) }; continue; }
          if (rule === "DET-01" && event.type === "duration" && event.known_ms > 10 && event.known_ms < 100) { yield { ...event, known_ms: 10 }; continue; }
          yield event;
          if (held.length && event.type === "outcome") { yield* held; held = []; }
          if (rule === "ORDER-01" && event.type === "outcome" && event.playback.reason === "completed" && plan?.pieces.length === 1) yield event;
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

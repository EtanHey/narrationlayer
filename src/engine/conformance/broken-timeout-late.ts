import type { Binding, Json } from "./binding";
import engine from "./engine-binding";
/** Deliver a fabricated receipt after the timed-out session's terminal event. */
export default { name: "broken-timeout-late", create(host) {
  const connection = engine.create(host);
  return { ...connection, events: (async function* () {
    for await (const event of connection.events) {
      yield event;
      if (event && typeof event === "object" && !Array.isArray(event) && event.type === "outcome"
        && event.generation && typeof event.generation === "object" && !Array.isArray(event.generation) && event.generation.reason === "synth_timeout") {
        yield { protocol: "nl.engine/1", type: "piece_ready", owner_epoch: event.owner_epoch, seq: Number(event.seq) + 1,
          session_id: event.session_id, attempt_id: "attempt-1-1", index: 0, piece_id: "late-piece", spoken_text: "Tin sails turn.", synthesis_ms: 101,
          start_ms: 0, duration_ms: 1, artifact: { handle: "late", lease_id: "late", format: "wav", sample_rate: 1000, sample_count: 1, sha256: "0".repeat(64) }, words: [], actual: [], synthesis: { rate: "+0%", attempts: [], unavailable: [], fallback_reason: null } } satisfies Json;
      }
    }
  })() };
} } satisfies Binding;

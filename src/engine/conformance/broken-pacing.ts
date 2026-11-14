import type { Message } from "../messages/messages";
import type { Binding, Json } from "./binding";
import engine from "./engine-binding";

/** Faults act on messages and the real synthesis port, without consulting cases. */
export function brokenPacing(rule: string): Binding {
  return { name: `broken-${rule}`, create(host) {
    const c = engine.create(host), queued = new Set<string>();
    let queuedRequest = false, shift = 0, lastExitAt = -1, duplicate = false;
    const commands = new Map<string, string>(), outcomes = new Map<string, Message<"outcome">>();
    return { resolve: c.resolve, shutdown: c.shutdown, send(message) {
      if (message && typeof message === "object" && !Array.isArray(message)) {
        if (message.type === "player_feedback" && message.edge === "exited") lastExitAt = host.clock.now();
        if (message.type === "narrate") {
          queuedRequest = !!message.start;
          if (rule === "PACE-01" && message.lookahead === 1)
            message = { ...message, lookahead: Number(message.lookahead ?? 2) + 1 };
        }
        if (message.type === "control" && typeof message.command_id === "string") {
          duplicate = lastExitAt === host.clock.now();
          if (rule === "CTRL-01") {
            const fingerprint = JSON.stringify(message), key = `${message.session_id}:${message.command_id}`;
            if (commands.get(key) === fingerprint) message = { ...message, command_id: `${message.command_id}:retry` };
            else commands.set(key, fingerprint);
          }
        }
      }
      c.send(message);
    }, events: (async function* (): AsyncGenerator<Json> {
      for await (const event of c.events) {
        if (event.type === "accepted" && queuedRequest) { queued.add(event.session_id); queuedRequest = false; }
        if (rule === "PACE-02" && event.type === "piece_ready" && event.index === 0 && queued.has(event.session_id)) {
          // Incorrectly regard prefetch as playing: subsequent pieces are genuinely synthesized.
          for (const edge of ["spawned", "first_sample"]) c.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: event.session_id, piece_index: 0, control_epoch: 1, player_instance_id: "player-0", edge, t_mono_ms: host.clock.now(), source: "player_reported" });
        }
        if (rule === "SESS-01" && event.type === "error" && event.code === "UNKNOWN_SESSION") {
          yield { protocol: "nl.engine/1", type: "control_ack", owner_epoch: event.owner_epoch, seq: event.seq, command_id: "stop-command", control_epoch: 0, outcome: "noop" }; continue;
        }
        if (event.type === "outcome") outcomes.set(event.session_id, event);
        if (rule === "ID-05e" && duplicate && event.type === "control_ack" && event.outcome === "noop" && [...outcomes.values()].at(-1)?.playback.reason === "completed") {
          yield { ...event, seq: event.seq + shift };
          const last = [...outcomes.values()].at(-1);
          if (last) { shift++; yield { ...last, seq: event.seq + shift }; }
          continue;
        }
        if (rule === "CTRL-01" && event.type === "control_ack" && event.command_id.endsWith(":retry")) { yield { ...event, command_id: event.command_id.slice(0, -6) }; continue; }
        yield "seq" in event ? { ...event, seq: event.seq + shift } : event;
      }
    })() };
  } };
}

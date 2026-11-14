import engine from "./engine-binding";
import type { Binding } from "./binding";
import type { Message } from "../messages/messages";
/** Four real faults missed by the original fixtures, supplied by round-one review. */
export function missedResync(fault: "planned-count" | "undelivered-timing" | "paused-current" | "replayed-resync"): Binding {
  return { name: `broken-resync-${fault}`, create(host) {
    const c = engine.create(host), plans = new Map<string, Message<"plan">>(), delivered = new Map<string, number>();
    const paused = new Set<string>(), stalePaused = new Set<string>(), resync = new Set<string>(), answered = new Set<string>();
    let snapshot: Message<"snapshot"> | undefined;
    return { ...c, send(m) {
      if (m && typeof m === "object" && !Array.isArray(m) && m.type === "control" && typeof m.session_id === "string" && typeof m.command_id === "string") {
        if (m.op === "pause" && m.expected_control_epoch === undefined) paused.add(m.session_id);
        if (m.op === "seek" && paused.has(m.session_id)) stalePaused.add(m.command_id);
        if (m.op === "resync") resync.add(m.command_id);
      }
      c.send(m);
    }, events: (async function* () { for await (const e of c.events) {
      if (e.type === "plan") plans.set(e.session_id, e);
      if (e.type === "piece_ready") delivered.set(e.session_id, (delivered.get(e.session_id) ?? 0) + 1);
      if (e.type === "snapshot") {
        snapshot = e;
        if (fault === "planned-count") { yield { ...e, sessions: e.sessions.map(s => ({ ...s, pieces_ready: plans.get(s.session_id)?.pieces.length ?? s.pieces_ready })) }; continue; }
      }
      if (e.type === "control_ack") {
        if (fault === "paused-current" && stalePaused.has(e.command_id) && e.reason === "STALE_EPOCH") { const { current, ...rest } = e; yield rest; continue; }
        if (fault === "replayed-resync" && resync.has(e.command_id)) {
          const replay = answered.has(e.command_id); answered.add(e.command_id); yield e;
          if (replay && snapshot) yield snapshot;
          continue;
        }
      }
      yield e;
      if (fault === "undelivered-timing" && e.type === "timing_update") {
        const next = plans.get(e.session_id)?.pieces[delivered.get(e.session_id) ?? 0];
        if (next) yield { ...e, piece_id: next.piece_id };
      }
    } })() };
  } };
}

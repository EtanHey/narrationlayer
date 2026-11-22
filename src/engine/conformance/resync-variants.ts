import type { Binding } from "./binding";
import type { Message } from "../messages/messages";
import engine from "./engine-binding";
type Fault = "snap" | "seq" | "stale" | "phase" | "count" | "last" | "words" | "plan" | "double";
/** Deliberate violations used to measure sensitivity of the packaged cases. */
export function wrongResync(fault: Fault): Binding {
  return { name: `broken-resync-${fault}`, create(host) {
    const c = engine.create(host), pieces: Message<"piece_ready">[] = [], plans = new Map<string, number>(), seeks = new Set<string>();
    let resync = false;
    return { ...c, send(m) {
      if (m && typeof m === "object" && !Array.isArray(m) && m.type === "control" && m.op === "seek" && typeof m.command_id === "string") seeks.add(m.command_id);
      c.send(m);
    }, events: (async function* () { for await (const e of c.events) {
      if (e.type === "piece_ready") pieces.push(e);
      if (e.type === "snapshot") {
        resync = true;
        if (["phase", "count", "last"].includes(fault)) { yield { ...e, sessions: e.sessions.map(s => ({ ...s, ...(fault === "phase" ? { phase: "paused" } : fault === "count" ? { pieces_ready: s.pieces_ready + 1 } : { last_seq: 0 }) })) }; continue; }
        yield e;
        if (fault === "snap" && pieces[0]) yield pieces[0];
        if (fault === "double") yield e;
        continue;
      }
      if (e.type === "plan") {
        if (resync && fault === "plan") continue;
        const first = plans.get(e.session_id); plans.set(e.session_id, first ?? e.seq);
        if (resync && fault === "seq") { yield { ...e, seq: first ?? e.seq }; continue; }
      }
      if (e.type === "timing_update" && e.derivation_id === "resync") {
        if (fault === "words") { yield { ...e, words: [] }; continue; }
        if (fault === "seq") { yield { ...e, seq: pieces.find(p => p.piece_id === e.piece_id)?.seq ?? e.seq }; continue; }
      }
      if (fault === "stale" && e.type === "control_ack" && e.reason === "STALE_EPOCH" && seeks.has(e.command_id)) {
        const { current, ...rest } = e; yield rest; continue;
      }
      yield e;
    } })() };
  } };
}

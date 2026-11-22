import type { Binding } from "./binding";
import type { Message } from "../messages/messages";
import engine from "./engine-binding";
/** Wrong: a delivered predecessor piece escapes again after replacement. */
const broken: Binding = { name: "broken-preempt-01", create(host) {
  const c = engine.create(host), pieces = new Map<string, Message<"piece_ready">>();
  return { ...c, events: (async function* () { for await (const e of c.events) {
    if (e.type === "piece_ready") pieces.set(e.session_id, e);
    yield e;
    if (e.type === "outcome" && e.playback.reason === "replaced") {
      const p = pieces.get(e.session_id); if (p) yield { ...p, seq: e.seq + 1 };
    }
  } })() };
} };
export default broken;

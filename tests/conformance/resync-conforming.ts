import engine from "../../src/engine/conformance/engine-binding";
import type { Binding } from "../../src/engine/conformance/binding";
import type { Event } from "../../src/engine/messages/messages";
/** Reviewer's conforming control: reverse sessions, preserve each session's order and sequence slots. */
export const reverseResync: Binding = { name: "reverse-resync-sessions", create(host) {
  const c = engine.create(host), seqs = new Map<number, number>();
  return { ...c, events: (async function* () {
    let block: Event[] = [], remaining = 0;
    for await (const event of c.events) {
      if (remaining) {
        block.push(event);
        if (--remaining) continue;
        const ids = [...new Set(block.flatMap(e => "session_id" in e ? [e.session_id] : []))].reverse();
        const slots = block.flatMap(e => "seq" in e ? [e.seq] : []);
        let index = 0;
        for (const id of ids) for (const e of block.filter(e => "session_id" in e && e.session_id === id)) {
          if ("seq" in e) { const seq = slots[index++]; seqs.set(e.seq, seq); yield { ...e, seq }; }
        }
        block = []; continue;
      }
      if (event.type === "snapshot") {
        remaining = event.sessions.reduce((n, s) => n + 1 + s.pieces_ready, 0);
        yield { ...event, sessions: event.sessions.map(s => ({ ...s, last_seq: seqs.get(s.last_seq) ?? s.last_seq })) };
      } else yield event;
    }
    if (remaining) throw Error("incomplete resync block");
  })() };
} };

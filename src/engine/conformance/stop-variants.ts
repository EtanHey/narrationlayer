import type { Binding } from "./binding";
import type { Event, Message } from "../messages/messages";
import { parseRequest } from "../messages/parser";
import engine from "./engine-binding";
type Fault = "started-queued" | "replaced-others" | "paused" | "queue-except" | "successors";
/** Review controls: each deliberately violates one reach/reason rule. */
export function wrongStop(fault: Fault): Binding {
  return { name: `broken-stop-${fault}`, create(host) {
    const c = engine.create(host), requests = new Map<string, string>(), after = new Map<string, string>();
    const started = new Set<string>(), paused = new Set<string>(), internal = new Set<string>();
    const seqs = new Map<number, number>(); let next = 0, command = 0;
    let lastStop: Extract<Message<"control">, { op: "stop" }> | undefined;
    return { ...c, send(raw) {
      const parsed = parseRequest(raw); if (!parsed.ok) { c.send(raw); return; }
      const m = parsed.value;
      if (m.type === "narrate" && typeof m.start === "object") requests.set(m.request_id, m.start.after_session);
      if (m.type === "player_feedback" && m.edge === "first_sample") started.add(m.session_id);
      if (m.type === "control" && m.op === "pause") paused.add(m.session_id);
      if (m.type !== "control" || m.op !== "stop") { c.send(raw); return; }
      lastStop = m;
      if (fault === "queue-except" && m.args.scope === "queue") c.send({ ...m, args: { ...m.args, except_sessions: [] } });
      else if (fault === "paused" && m.args.scope === "all_speech") c.send({ ...m, args: { ...m.args, except_sessions: [...(m.args.except_sessions ?? []), ...[...paused].filter(id => id !== m.session_id)] } });
      else c.send(raw);
      for (const [id, predecessor] of after) {
        const extra = fault === "started-queued" && m.args.scope === "queue" && started.has(id) && !m.args.except_sessions?.includes(id)
          || fault === "successors" && m.args.scope === "session" && predecessor === m.session_id && !m.args.except_sessions?.includes(m.session_id);
        if (extra) {
          const command_id = `review-internal-${++command}`; internal.add(command_id);
          c.send({ ...m, command_id, session_id: id, args: { ...m.args, scope: "session" } });
        }
      }
    }, events: (async function* () { for await (const event of c.events) {
      if (event.type === "accepted") { const predecessor = requests.get(event.request_id); if (predecessor) after.set(event.session_id, predecessor); }
      if (event.type === "control_ack" && internal.has(event.command_id)) continue;
      let e: Event = event;
      if (fault === "replaced-others" && e.type === "outcome" && lastStop?.args.scope === "all_speech" && lastStop.args.reason === "replaced" && e.session_id !== lastStop.session_id) e = { ...e, playback: { reason: "stop" } };
      if ("seq" in e) { const seq = seqs.get(e.seq) ?? ++next; seqs.set(e.seq, seq); yield { ...e, seq }; }
      else yield e;
    } })() };
  } };
}

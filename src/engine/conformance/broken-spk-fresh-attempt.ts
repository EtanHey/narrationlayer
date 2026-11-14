import type { Binding } from "./binding";
import type { Message } from "../messages/messages";
import engine from "./engine-binding";
/** Wrong engine publishes a cancelled result under a fresh attempt in the stopped session. */
export default { name: "broken-spk-fresh-attempt", create(host) {
  let late = false, stopped = false;
  const backend = host.ports?.backend;
  if (backend) {
    const synthesize = backend.synthesizeRequest.bind(backend);
    backend.synthesizeRequest = async (request, signal) => {
      const result = await synthesize(request, signal);
      if (signal.aborted) late = true;
      return result;
    };
  }
  const inner = engine.create(host);
  let piece: Message<"piece_ready"> | undefined, pending: Message<"accepted"> | undefined, seq = 0;
  return { ...inner, send(message) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "control" && message.op === "stop" && message.args && typeof message.args === "object" && !Array.isArray(message.args) && message.args.scope === "all_speech" && piece && pending && pending.session_id !== piece.session_id) stopped = true;
    inner.send(message);
  }, events: (async function* () {
    for await (const event of inner.events) {
      if (event.type === "piece_ready") piece = event;
      if (event.type === "accepted") pending = event;
      if ("seq" in event) seq = event.seq;
      yield event;
    }
    if (stopped && late && piece && pending)
      yield { ...piece, session_id: pending.session_id, attempt_id: `${pending.attempt_id}-late`, seq: seq + 1 };
  })() };
} } satisfies Binding;

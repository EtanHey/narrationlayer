import type { Binding } from "./binding";
import type { Message } from "../messages/messages";
import engine from "./engine-binding";
/** Wrong engine revives a stopped attempt only after a delivered prefix. */
export default { name: "broken-spk-05e", create(host) {
  const inner = engine.create(host), stops = new Set<string>();
  return { ...inner, send(message) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "control" && message.op === "stop" && typeof message.command_id === "string") stops.add(message.command_id);
    inner.send(message);
  }, events: (async function* () {
    let piece: Message<"piece_ready"> | undefined;
    for await (const event of inner.events) {
      if (event.type === "piece_ready") piece = event;
      yield event;
      if (event.type === "control_ack" && event.outcome === "accept" && stops.has(event.command_id) && piece)
        yield { ...piece, seq: event.seq + 1 };
    }
  })() };
} } satisfies Binding;

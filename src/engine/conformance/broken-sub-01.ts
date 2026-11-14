import type { Binding } from "./binding";
import engine from "./engine-binding";
export default { name: "broken-sub-01", create(host) {
  const connection = engine.create(host);
  return { ...connection, events: (async function* () {
    for await (const event of connection.events) yield event.type === "piece_ready" ? { ...event, actual: event.actual.map(a => ({ ...a, substituted: false })) } : event;
  })() };
} } satisfies Binding;

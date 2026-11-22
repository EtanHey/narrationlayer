import type { Binding } from "./binding";
import engine from "./engine-binding";
export default { name: "broken-life-future", create(host) {
  const connection = engine.create(host);
  return { ...connection, events: (async function* () { for await (const event of connection.events)
    yield event.type === "lifecycle" && event.edge === "audio_ready" && event.piece_index === 2 ? { ...event, t_mono_ms: event.t_mono_ms + 100000 } : event;
  })() };
} } satisfies Binding;

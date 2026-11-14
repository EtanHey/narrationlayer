import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Old shutdown reason and old post-shutdown release admission. */
export default { name: "broken-SHUT-01", create(host) {
  const c = engine.create(host); let closed = false;
  return { ...c, send(message) { if (!closed) c.send(message); },
    shutdown(deadline) { closed = true; return c.shutdown(deadline); },
    events: (async function* () { for await (const e of c.events)
      yield e.type === "outcome" && e.playback.reason === "shutdown" ? { ...e, playback: { reason: "cancel" } } : e;
    })() };
} } satisfies Binding;

import type { Binding } from "./binding";
import type { Message } from "../messages/messages";
import engine from "./engine-binding";
export default { name: "broken-life-failed-future", create(host) {
  const c = engine.create(host);
  return { ...c, events: (async function* () {
    let pending: Message<"lifecycle"> | undefined;
    for await (const e of c.events) {
      if (pending) { yield e.type === "error" ? { ...pending, t_mono_ms: pending.t_mono_ms + 100000 } : pending; pending = undefined; }
      if (e.type === "lifecycle" && e.edge === "synthesis_requested" && e.piece_index === 1) pending = e;
      else yield e;
    }
    if (pending) yield pending;
  })() };
} } satisfies Binding;

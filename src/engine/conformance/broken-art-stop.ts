import type { Binding } from "./binding";
import type { Message } from "../messages/messages";
import engine from "./engine-binding";
export default { name: "broken-ART-STOP", create(host) {
  const c = engine.create(host), pieces = new Map<string, Message<"piece_ready">>();
  return { ...c, events: (async function* () { for await (const e of c.events) {
    if (e.type === "piece_ready" && e.index === 0) pieces.set(e.session_id, e);
    const p = e.type === "outcome" ? pieces.get(e.session_id) : undefined;
    if (e.type === "outcome" && e.playback.reason === "stop" && p && !e.artifacts.some(a => a.lease_id === p.artifact.lease_id)) {
      yield { ...e, artifacts: [{ piece_id: p.piece_id, handle: p.artifact.handle, lease_id: p.artifact.lease_id }, ...e.artifacts] }; continue;
    }
    yield e;
  } })() };
} } satisfies Binding;

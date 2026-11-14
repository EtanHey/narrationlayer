import type { Binding } from "../../src/engine/conformance/binding";
import engine from "../../src/engine/conformance/engine-binding";
/** A seek may be processed later than send's synchronous return. */
export function slowSeek(delay: 3 | 20): Binding {
  return { name: `seek-delayed-${delay}`, create(host) {
    const inner = engine.create(host);
    return { ...inner, send(message) {
      if (message && typeof message === "object" && !Array.isArray(message) && message.type === "control" && message.op === "seek")
        queueMicrotask(() => { host.clock.schedule(delay, () => inner.send(message)); });
      else inner.send(message);
    } };
  } };
}

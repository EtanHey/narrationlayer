import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Restore the old inline run start, including starts allowed by control feedback. */
export default { name: "broken-bind-start", create(host) {
  const c = engine.create(host);
  return { ...c, send(message) {
    const enqueue = globalThis.queueMicrotask;
    globalThis.queueMicrotask = action => { globalThis.queueMicrotask = enqueue; action(); };
    try { c.send(message); } finally { globalThis.queueMicrotask = enqueue; }
  } };
} } satisfies Binding;

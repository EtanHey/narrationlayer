import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Restore inline abort firing while preserving deferred run starts. */
export default { name: "broken-bind-abort", create(host) {
  if (!host.ports) return engine.create(host);
  const backend = host.ports.backend, synthesize = backend.synthesizeRequest.bind(backend);
  const controllers = new Map<AbortSignal, AbortController>();
  backend.synthesizeRequest = (request, signal) => {
    const controller = new AbortController(); controllers.set(signal, controller);
    signal.addEventListener("abort", () => controller.abort(), { once: true });
    return synthesize(request, controller.signal);
  };
  const c = engine.create(host);
  const fire = () => { for (const controller of controllers.values()) controller.abort(); };
  return { ...c, send(message) {
    c.send(message);
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "control" && message.op === "stop") fire();
  }, shutdown(deadline) { const pending = c.shutdown(deadline); fire(); return pending; } };
} } satisfies Binding;

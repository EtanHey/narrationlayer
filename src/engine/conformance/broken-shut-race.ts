import type { Binding } from "./binding";
import engine from "./engine-binding";
export default { name: "broken-shut-race", create(host) {
  const connection = engine.create(host), calls = new Set<Promise<unknown>>();
  if (host.ports) {
    const backend = host.ports.backend, call = backend.synthesizeRequest.bind(backend);
    backend.synthesizeRequest = (request, signal) => {
      const pending = call(request, signal); calls.add(pending);
      void pending.then(() => { calls.delete(pending); }, () => { calls.delete(pending); });
      return pending;
    };
  }
  return { ...connection, shutdown(deadline) {
    const pending = [...calls].map(p => p.then(() => {}, () => {}));
    const real = connection.shutdown(deadline);
    return pending.length ? Promise.race([real, ...pending]) : real;
  } };
} } satisfies Binding;

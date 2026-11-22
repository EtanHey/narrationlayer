import type { Binding } from "./binding";
import engine from "./engine-binding";
export default { name: "broken-ART-01", create(host) {
  const c = engine.create(host); let previous: string | undefined;
  return { ...c, events: (async function* () { for await (const e of c.events) {
    if (e.type === "piece_ready") { if (previous) host.store.delete(previous); previous = e.artifact.handle; }
    yield e;
  } })() };
} } satisfies Binding;

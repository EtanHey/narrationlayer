import type { Binding } from "./binding";
import engine from "./engine-binding";
export default { name: "broken-ART-04", create(host) {
  const c = engine.create(host);
  return { ...c, events: (async function* () { for await (const e of c.events) {
    if (e.type === "error" && e.code === "ARTIFACT_EXPIRED" && e.details) continue;
    yield e;
  } })() };
} } satisfies Binding;

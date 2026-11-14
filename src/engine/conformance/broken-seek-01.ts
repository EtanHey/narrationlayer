import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Wrong: acknowledge unavailable words as accepted. */
const broken: Binding = { name: "broken-seek-01", create(host) {
  const c = engine.create(host);
  return { ...c, events: (async function* () { for await (const e of c.events) {
    yield e.type === "control_ack" && e.reason === "word timing unavailable" ? { ...e, outcome: "accept" } : e;
  } })() };
} };
export default broken;

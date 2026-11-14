import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Wrong: acknowledge an ended read's seek as accepted. */
const broken: Binding = { name: "broken-seek-ended-accepted", create(host) {
  const c = engine.create(host), seeks = new Set<string>(), ended = new Set<string>();
  return { ...c, send(message) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "control" && message.op === "seek" && typeof message.command_id === "string" && typeof message.session_id === "string" && ended.has(message.session_id)) seeks.add(message.command_id);
    c.send(message);
  }, events: (async function* () { for await (const e of c.events) {
    if (e.type === "outcome") ended.add(e.session_id);
    yield e.type === "control_ack" && seeks.has(e.command_id) ? { ...e, outcome: "accept" } : e;
  } })() };
} };
export default broken;

import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Wrong: discard the seek's expected epoch before applying it. */
const broken: Binding = { name: "broken-seek-stale-taken", create(host) {
  const c = engine.create(host);
  return { ...c, send(message) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "control" && message.op === "seek") {
      const { expected_control_epoch, ...rest } = message; message = rest;
    }
    c.send(message);
  } };
} };
export default broken;

import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Wrong: erase both stale-control fences before handing a pause to the engine. */
const broken: Binding = { name: "broken-pause-01", create(host) {
  const c = engine.create(host);
  return { ...c, send(message) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "control" && message.op === "pause") {
      const { expected_control_epoch, player_instance_id, ...rest } = message;
      message = rest;
    }
    c.send(message);
  } };
} };
export default broken;

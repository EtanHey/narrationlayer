import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Wrong: promote an old failed exit into the latest player's epoch. */
const broken: Binding = { name: "broken-id-01e", create(host) {
  const c = engine.create(host); let latest: Record<string, import("./binding").Json> | undefined;
  return { ...c, send(message) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "player_feedback") {
      if (message.edge === "spawned") latest = message;
      else if (message.edge === "exited" && latest && Number(message.control_epoch) < Number(latest.control_epoch)) message = { ...message, control_epoch: latest.control_epoch!, player_instance_id: latest.player_instance_id!, piece_index: latest.piece_index! };
    }
    c.send(message);
  } };
} };
export default broken;

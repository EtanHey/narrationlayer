import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Wrong: rewrite a resume's owner to whoever currently holds the pause. */
const broken: Binding = { name: "broken-pause-02", create(host) {
  const c = engine.create(host), owners = new Map<string, string>();
  return { ...c, send(message) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "control" && typeof message.session_id === "string" && message.args && typeof message.args === "object" && !Array.isArray(message.args)) {
      const id = message.session_id, owner = message.args.owner;
      if (message.op === "pause" && typeof owner === "string" && (!owners.has(id) || owner === "user")) owners.set(id, owner);
      if (message.op === "resume" && owners.has(id)) { message = { ...message, args: { owner: owners.get(id)! } }; owners.delete(id); }
    }
    c.send(message);
  } };
} };
export default broken;

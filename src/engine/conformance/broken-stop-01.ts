import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Wrong: all_speech ignores the explicitly spared sessions. */
const broken: Binding = { name: "broken-stop-01", create(host) {
  const c = engine.create(host);
  return { ...c, send(message) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "control" && message.op === "stop") {
      const args = message.args;
      if (args && typeof args === "object" && !Array.isArray(args) && args.scope === "all_speech") {
        c.send({ ...message, args: { ...args, except_sessions: [] } }); return;
      }
    }
    c.send(message);
  } };
} };
export default broken;

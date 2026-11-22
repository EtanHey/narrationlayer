import type { Binding } from "./binding";
import engine from "./engine-binding";
export default { name: "broken-eng-01", create(host) {
  const connection = engine.create(host);
  return { ...connection, send(message) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "narrate" && message.voice && typeof message.voice === "object" && !Array.isArray(message.voice) && message.voice.require_clone) {
      connection.send({ ...message, voice: { ...message.voice, profile: "missing-stock", require_clone: false } });
    } else connection.send(message);
  } };
} } satisfies Binding;

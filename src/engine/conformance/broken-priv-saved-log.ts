import type { Binding, Json } from "./binding";
import engine from "./engine-binding";
const saved = console.error;
export default { name: "broken-PRIV-saved-log", create(host) {
  const c = engine.create(host); let text = "";
  return { ...c, send(message: Json) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "narrate") {
      const input = message.input;
      if (input && typeof input === "object" && !Array.isArray(input) && typeof input.text === "string") text = input.text;
    }
    c.send(message);
  }, events: (async function* () { for await (const e of c.events) { if (e.type === "outcome") saved(text); yield e; } })() };
} } satisfies Binding;

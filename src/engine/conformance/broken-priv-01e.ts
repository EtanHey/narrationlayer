import type { Binding, Json } from "./binding";
import engine from "./engine-binding";
// The faulty long-input diagnostic branch includes a snippet on synthesis failure.
export default { name: "broken-PRIV-01e", create(host) {
  const c = engine.create(host); let text = "";
  return { ...c, send(message: Json) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.type === "narrate") {
      const input = message.input;
      if (input && typeof input === "object" && !Array.isArray(input) && typeof input.text === "string") text = input.text;
    }
    c.send(message);
  }, events: (async function* () { for await (const e of c.events)
    yield e.type === "error" && e.code === "SYNTH_FAILED" && text.length >= 96 ? { ...e, message: text.slice(0, 16) } : e;
  })() };
} } satisfies Binding;

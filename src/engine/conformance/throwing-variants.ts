import engine from "./engine-binding";
import type { Binding } from "./binding";
/** Deliberately wrong only when a host installs the R100 emission observer. */
export function wrongThrow(mode: "escape" | "halt"): Binding {
  return { name: `throw-${mode}`, create(host) {
    let halted = false;
    const callback = host.observe?.event;
    const pending: [unknown, boolean][] = [];
    const connection = engine.create({ ...host, observe: { event(event, replay) {
      if (mode === "escape") { pending.push([event, replay]); return; }
      try { callback?.(event, replay); } catch { halted = true; }
    } } });
    return { ...connection, send(message) {
      if (mode === "halt" && halted) return;
      connection.send(message);
      if (mode === "escape") for (const [event, replay] of pending.splice(0)) callback?.(event, replay);
    } };
  } };
}

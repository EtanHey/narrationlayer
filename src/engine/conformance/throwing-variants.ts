import engine from "./engine-binding";
import type { Binding } from "./binding";
/** Deliberately wrong only when a host installs the R100 emission observer. */
export function wrongThrow(mode: "escape" | "halt"): Binding {
  return { name: `throw-${mode}`, create(host) {
    let halted = false;
    const callback = host.observe?.event;
    const connection = engine.create({ ...host, observe: { event(event, replay) {
      try { callback?.(event, replay); } catch (error) { halted = true; if (mode === "escape") throw error; }
    } } });
    return { ...connection, send(message) {
      if (mode === "halt" && halted) return;
      connection.send(message);
      if (mode === "escape") callback?.({ type: "synthetic" }, false);
    } };
  } };
}

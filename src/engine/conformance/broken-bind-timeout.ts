import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Suppress only the synthesis bound, preserving other host-clock work. */
export default { name: "broken-bind-timeout", create(host) {
  const clock = { ...host.clock, schedule(ms: number, callback: () => void) {
    return ms === (host.synthesis_timeout_ms ?? 2000) ? () => {} : host.clock.schedule(ms, callback);
  } };
  return engine.create({ ...host, clock });
} } satisfies Binding;

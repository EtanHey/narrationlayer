import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Deliberate faults at the port/wire boundaries, never imported by product code. */
export function wrongFallback(fault: "required" | "marks" | "truncate" | "voice" | "rate" | "reason" | "timing"): Binding {
  return { name: `wrong-fallback-${fault}`, create(host) {
    let substituted = false;
    const caps = host.engines?.map(e => fault === "truncate" && e.family === "edge" ? { ...e, max_chars: 1000 } : e);
    const backend = host.ports?.backend;
    const c = engine.create({ ...host, engines: caps, ...(backend && host.ports ? { ports: { ...host.ports, backend: {
      script: steps => backend.script(steps), get calls() { return backend.calls; },
      synthesizeRequest(r, signal) {
        const cap = host.engines?.find(e => e.family === r.family)?.max_chars;
        return backend.synthesizeRequest(fault === "truncate" && r.family === "edge" ? { ...r, text: r.text.slice(0, cap) } : r, signal);
      },
    } } } : {}) });
    return { ...c, send(m) {
      if (fault === "required" && host.engines?.some(e => e.family === "qwen3_clone" && e.available) && m && typeof m === "object" && !Array.isArray(m) && m.type === "narrate" && m.voice && typeof m.voice === "object" && !Array.isArray(m.voice))
        c.send({ ...m, voice: { ...m.voice, require_clone: false, fallback: "declared" } });
      else c.send(m);
    }, events: (async function* () {
      for await (const e of c.events) {
        if (e && typeof e === "object" && !Array.isArray(e) && e.type === "piece_ready") {
          const synthesis = e.synthesis;
          const fallback = synthesis && typeof synthesis === "object" && !Array.isArray(synthesis) && synthesis.fallback_reason === "clone_synthesis_failed";
          substituted ||= !!fallback;
          if ((fault === "marks" && substituted || fault === "voice" && fallback) && Array.isArray(e.actual))
            e.actual = e.actual.map(a => a && typeof a === "object" && !Array.isArray(a) ? { ...a, ...(fault === "marks" ? { substituted: true } : { voice: "wrong-stock" }) } : a);
          if (fallback && synthesis && typeof synthesis === "object" && !Array.isArray(synthesis)) {
            if (fault === "rate") synthesis.rate = "+25%";
            if (fault === "reason") synthesis.fallback_reason = null;
            if (fault === "timing" && Array.isArray(e.words)) e.words = e.words.map(w => w && typeof w === "object" && !Array.isArray(w) ? { ...w, timing: "measured" } : w);
          }
        }
        yield e;
      }
    })() };
  } };
}

import type { Binding } from "../../src/engine/conformance/binding";
import type { Event } from "../../src/engine/messages/messages";
import engine from "../../src/engine/conformance/engine-binding";
/** Contract permits outcomes of different stopped sessions in either order. */
export const reverseOutcomes: Binding = { name: "reverse-stop-outcomes", create(host) {
  const c = engine.create(host), out: Event[] = [], wake: (() => void)[] = [];
  const commands = new Set<string>(), seqs = new Map<number, number>();
  let next = 0, ended = false, stopping = false, timer = false;
  let buffer: Event[] = [];
  const push = (e: Event) => {
    if ("seq" in e) { const seq = seqs.get(e.seq) ?? ++next; seqs.set(e.seq, seq); out.push({ ...e, seq }); }
    else out.push(e);
    wake.splice(0).forEach(resolve => resolve());
  };
  const flush = () => { const events = buffer.reverse(); buffer = []; events.forEach(push); };
  void (async () => {
    for await (const e of c.events) {
      if (stopping && e.type === "outcome") {
        buffer.push(e);
        if (!timer) { timer = true; host.clock.schedule(0, () => { timer = false; flush(); wake.splice(0).forEach(resolve => resolve()); }); }
        continue;
      }
      flush(); push(e); stopping = e.type === "control_ack" && commands.has(e.command_id);
    }
    flush(); ended = true; wake.splice(0).forEach(resolve => resolve());
  })();
  return { ...c, send(m) {
    if (m && typeof m === "object" && !Array.isArray(m) && m.type === "control" && m.op === "stop" && typeof m.command_id === "string") commands.add(m.command_id);
    c.send(m);
  }, events: (async function* () {
    while (!ended || timer || out.length) {
      const e = out.shift(); if (e) { yield e; continue; }
      await new Promise<void>(resolve => wake.push(resolve));
    }
  })() };
} };

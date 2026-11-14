import type { Binding, Json } from "./binding";
import engine from "./engine-binding";
export default { name: "broken-shut-late", create(host) {
  const connection = engine.create(host), queue: Json[] = [], wake: (() => void)[] = [];
  let ended = false, hold = false;
  const notify = () => { wake.splice(0).forEach(resolve => resolve()); };
  void (async () => { for await (const event of connection.events) { queue.push(event); notify(); } ended = true; notify(); })();
  return { ...connection, shutdown(deadline) {
    hold = true;
    const pending = connection.shutdown(deadline + 63);
    void pending.then(() => { hold = false; notify(); }, () => { hold = false; notify(); });
    return pending;
  }, events: (async function* () {
    while (true) {
      if (queue.length) { const event = queue.shift(); if (event !== undefined) yield event; continue; }
      if (ended && !hold) return;
      await new Promise<void>(resolve => { wake.push(resolve); });
    }
  })() };
} } satisfies Binding;

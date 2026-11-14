import engine from "../../src/engine/conformance/engine-binding";
import type { Binding, Json } from "../../src/engine/conformance/binding";
const turns = async (n: number) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
export function conforming(mode: string): Binding {
  return { name: mode, create(host) {
    let tail: Promise<unknown> = Promise.resolve();
    if (host.ports) {
      const backend = host.ports.backend, call = backend.synthesizeRequest.bind(backend);
      backend.synthesizeRequest = async (request, signal) => {
        if (mode === "events") return call(request, signal);
        if (mode === "abort") {
          const relay = new AbortController();
          signal.addEventListener("abort", () => { host.clock.schedule(0, () => relay.abort()); }, { once: true });
          if (signal.aborted) host.clock.schedule(0, () => relay.abort());
          return call(request, relay.signal);
        }
        if (mode === "timer") await new Promise<void>(resolve => { host.clock.schedule(0, resolve); });
        if (mode === "two" || mode === "eight") await turns(mode === "two" ? 2 : 8);
        if (mode === "serial") {
          const next = tail.then(() => signal.aborted ? Promise.reject(Error("cancelled")) : call(request, signal));
          tail = next.catch(() => {}); return next;
        }
        if (signal.aborted) throw Error("cancelled");
        return call(request, signal);
      };
    }
    const connection = engine.create(host);
    if (mode !== "events") return connection;
    const out: Json[] = [], wake: (() => void)[] = [];
    let ended = false, pending = 0;
    void (async () => {
      for await (const event of connection.events) {
        pending++;
        host.clock.schedule(1, () => { out.push(event); pending--; wake.splice(0).forEach(resolve => resolve()); });
      }
      ended = true; wake.splice(0).forEach(resolve => resolve());
    })();
    return { ...connection, events: (async function* () {
      while (!ended || pending || out.length) {
        if (out.length) { const event = out.shift(); if (event !== undefined) yield event; continue; }
        await new Promise<void>(resolve => { wake.push(resolve); });
      }
    })() };
  } };
}

import { expect, test } from "bun:test";
import type { Binding } from "../../src/engine/conformance/binding";
import engine from "../../src/engine/conformance/engine-binding";
import { runCase, cases } from "../../src/engine/conformance/runner";

// L172 gives an acknowledgement no instant-delivery deadline. Preserve stream order.
const delayedAck: Binding = { name: "delayed-ack", create(host) {
  const connection = engine.create(host);
  return { ...connection, events: (async function* () {
    for await (const event of connection.events) {
      if (event.type === "control_ack") await new Promise<void>(resolve => { host.clock.schedule(1, resolve); });
      yield event;
    }
  })() };
} };
for (const id of ["PAUSE-01e", "PAUSE-02e", "PAUSE-03e"]) {
  test(`${id}: conforming acknowledgements delayed by 1 ms pass`, async () => {
    expect((await runCase(id, delayedAck, cases[id])).result).toBe("pass");
  });
}

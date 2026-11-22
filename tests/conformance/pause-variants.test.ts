import { expect, test } from "bun:test";
import type { Binding, Json } from "../../src/engine/conformance/binding";
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

for (const owner of ["f5", "ask"] as const) test(`PAUSE-02e catches a direct ${owner} park carried into the next read`, async () => {
  const carriesPark: Binding = { name: `carry-${owner}`, create(host) {
    const connection = engine.create(host);
    let parked: Json | undefined, carry = false;
    return { ...connection, send(message) {
      if (message && typeof message === "object" && !Array.isArray(message) && message.type === "control") {
        if (message.op === "pause" && message.args && typeof message.args === "object" && !Array.isArray(message.args)) parked = message.args.owner;
        if (message.command_id === "park-stop") carry = parked === owner;
      }
      connection.send(message);
    }, events: (async function* () {
      for await (const event of connection.events) {
        if (carry && event.type === "accepted" && event.request_id === "next-read") {
          carry = false;
          connection.send({ protocol: "nl.engine/1", type: "control", session_id: event.session_id, command_id: "invented-carry", op: "pause", args: { owner } });
        }
        yield event;
      }
    })() };
  } };
  expect((await runCase("PAUSE-02e", carriesPark, cases["PAUSE-02e"])).result).toBe("fail");
});

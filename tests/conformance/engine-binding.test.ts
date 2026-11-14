import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createEngineSession } from "../../src/engine/session/session";
import { ScriptedBackend, pcmAudio } from "../../src/engine/conformance/fake-backend";
import { ScriptedPlayer, ScriptedSpawn } from "../../src/engine/conformance/fake-player";
import { ScriptedHost } from "../../src/engine/conformance/host-stub";
import engine from "../../src/engine/conformance/engine-binding";
import { FakeClock } from "../../src/engine/conformance/clock";
import { runCase } from "../../src/engine/conformance/runner";
import { engineCases, hello } from "../../src/engine/conformance/engine-cases";
const root = resolve(import.meta.dir, "../..");
const runtime = process.env.CONFORMANCE_BUN ?? process.execPath;
const ids = ["PLAN-LAT-01", "ORDER-01", "ERR-01", "ID-03", "ID-04", "TIME-02", "GEN-02", "LIFE-01e", "TIME-01", "GEN-01e", "WORD-02", "DET-01"];
async function proof(id: string) {
  const name = id === "engine" ? "engine-binding" : `broken-${id.toLowerCase()}`;
  const proc = Bun.spawn([runtime, resolve(root, "src/engine/conformance/entry.ts"), "--binding", resolve(root, `src/engine/conformance/${name}.ts`), ...(process.platform === "darwin" ? ["--require-containment"] : [])], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(err).toBe(""); expect(code).toBe(id === "engine" ? 0 : 1);
  const report = JSON.parse(out);
  expect(report.rows.filter((r: { result: string }) => r.result === "fail").map((r: { id: string }) => r.id)).toEqual(id === "engine" ? [] : JSON.parse(readFileSync(resolve(root, `src/engine/conformance/${name}.fail-set.json`), "utf8")));
  if (process.platform === "darwin") expect(report.containment).toBe("macos-sandbox");
}
test("engine binding: the packaged entry passes the active cases under containment", () => proof("engine"));
for (const id of ["PLAN-D5", "PLAN-01", "PAUSE-PL-01", "PLAN-03"]) test(`${id}: the broken engine is red on exactly this case`, () => proof(id));
for (let i = 0; i < ids.length; i += 4) {
  const group = ids.slice(i, i + 4);
  test(`broken engines match their exact fail-sets: ${group.join(", ")}`, async () => {
    const errors: string[] = [];
    for (const id of group) { try { await proof(id); } catch (error) { errors.push(`${id}: ${String(error)}`); } }
    if (errors.length) throw new Error(errors.join("\n"));
  });
}
test("optional negotiation emits one unnumbered welcome; malformed and repeated hello are refused", async () => {
  const clock = new FakeClock(), c = engine.create({ clock, store: new Map(), hash_key: new Uint8Array(32), audible: false });
  const stream = c.events[Symbol.asyncIterator]();
  c.send({ protocol: "nl.engine/1", type: "control", op: "resync", args: {}, command_id: "command", session_id: "session" });
  expect((await stream.next()).value).toMatchObject({ type: "error", code: "NOT_NEGOTIATED", seq: 1 });
  c.send({ protocol: "nl.engine/1", type: "hello" });
  expect((await stream.next()).value).toMatchObject({ type: "error", code: "INVALID_REQUEST", seq: 2 });
  c.send(hello); const welcome = (await stream.next()).value;
  expect(welcome).toMatchObject({ type: "welcome", owner_epoch: 1 }); expect(welcome).not.toHaveProperty("seq");
  c.send(hello); expect((await stream.next()).value).toMatchObject({ type: "error", code: "INVALID_REQUEST", seq: 3 });
  await c.shutdown(0);
});

test("before negotiation garbage is NOT_NEGOTIATED; malformed hello retains parser codes", async () => {
  const clock = new FakeClock(), c = engine.create({ clock, store: new Map(), hash_key: new Uint8Array(32), audible: false });
  const stream = c.events[Symbol.asyncIterator]();
  for (const message of [null, 3, {}, { garbage: true }, { type: "narrate" }, { type: "unknown", protocol: "nl.engine/2" }]) {
    c.send(message); expect((await stream.next()).value).toMatchObject({ type: "error", code: "NOT_NEGOTIATED", phase: "negotiate" });
  }
  for (const [protocol, code] of [["nl.engine/1", "INVALID_REQUEST"], ["nl.engine/2", "UNSUPPORTED_VERSION"]]) {
    c.send({ type: "hello", protocol }); expect((await stream.next()).value).toMatchObject({ type: "error", code });
  }
  await c.shutdown(0);
});

test("without welcome the existing session keeps parser refusals before hello", async () => {
  const c = createEngineSession({ owner_epoch: 1, clock: new FakeClock(), limits: { max_chars: { read: 1000, speak: 1000, ask_prompt: 1000 }, lookahead: 2, aligner_reap_ms: 50 },
    planner: { plan() { throw new Error("unused"); } }, backend: { async synthesizeRequest() { throw new Error("unused"); } },
    publication: { async piece() { throw new Error("unused"); }, async commit() {} } });
  const stream = c.events[Symbol.asyncIterator]();
  for (const message of [null, {}, { type: "narrate" }, { type: "hello", protocol: "nl.engine/1" }]) {
    c.send(message); expect((await stream.next()).value).toMatchObject({ type: "error", code: "INVALID_REQUEST" });
  }
  await c.shutdown(0);
});
test("two engines sharing a store refuse a colliding epoch handle without overwriting bytes", async () => {
  const store = new Map<string, Uint8Array>();
  async function run(samples: number) {
    const clock = new FakeClock(), backend = new ScriptedBackend(clock), spawn = new ScriptedSpawn(clock), player = new ScriptedPlayer(clock, spawn);
    backend.script([{ latency_ms: 1, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(samples) } }]);
    const c = engine.create({ clock, store, hash_key: new Uint8Array(32), audible: false, ports: { backend, spawn, player, host: new ScriptedHost(clock) } });
    const seen: unknown[] = [], collect = (async () => { for await (const event of c.events) seen.push(event); })();
    c.send(hello); c.send({ protocol: "nl.engine/1", type: "narrate", request_id: "request-store", idempotency_key: "store-key", use: "read", input: { text: "Copper boats drift.", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" });
    await clock.advance(1); for (let i = 0; i < 24; i++) await Promise.resolve();
    await c.shutdown(1); await collect; backend.assertDrained(); return seen;
  }
  expect(await run(100)).toContainEqual(expect.objectContaining({ type: "piece_ready", artifact: expect.objectContaining({ handle: "memory:1:1" }) }));
  const first = store.get("memory:1:1")?.slice();
  expect(await run(200)).toContainEqual(expect.objectContaining({ type: "error", code: "SYNTH_FAILED" }));
  expect(store.size).toBe(1); expect(store.get("memory:1:1")).toEqual(first);
});

test("pre-hello narrate refusal preserves only a bounded request id", async () => {
  const c = engine.create({ clock: new FakeClock(), store: new Map(), hash_key: new Uint8Array(32), audible: false });
  const stream = c.events[Symbol.asyncIterator]();
  for (const id of ["request-pre", "x", "x".repeat(129)]) {
    c.send({ protocol: "nl.engine/1", type: "narrate", request_id: id, idempotency_key: "pre-key", use: "read", input: { text: "Amber rafts float.", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" });
    const error = (await stream.next()).value;
    expect(error).toMatchObject({ type: "error", code: "NOT_NEGOTIATED", phase: "negotiate", retry: "after_resync" });
    expect(error?.request_id).toBe(id.length >= 3 && id.length <= 128 ? id : undefined);
  }
  await c.shutdown(0);
});

test("PLAN-LAT-01 bounds a swallowed second narrate under the fake clock", async () => {
  const broken = { name: "drops-second", create: (host: Parameters<typeof engine.create>[0]) => {
    const c = engine.create(host); let calls = 0;
    return { ...c, send: (message: Parameters<typeof c.send>[0]) => {
      if (message && typeof message === "object" && !Array.isArray(message) && "type" in message && message.type === "narrate" && ++calls > 1) return;
      c.send(message);
    } };
  } };
  expect((await runCase("PLAN-LAT-01", broken, engineCases["PLAN-LAT-01"])).result).toBe("fail");
});

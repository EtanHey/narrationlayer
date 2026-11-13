import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BackendAudio, BackendStep, Json } from "../../src/engine/conformance/binding.js";
import { FakeClock } from "../../src/engine/conformance/clock.js";
import { pcmAudio, ScriptedBackend } from "../../src/engine/conformance/fake-backend.js";
import { ScriptedPlayer, ScriptedSpawn } from "../../src/engine/conformance/fake-player.js";
import { ScriptedHost } from "../../src/engine/conformance/host-stub.js";
import { withoutWallTime } from "../../src/engine/conformance/wall-guard.js";

const audioStep = (audio = pcmAudio(100), latency_ms = 10, late_after_cancel = false): BackendStep => ({ latency_ms, late_after_cancel, result: { kind: "audio", ...audio } });
const setup = () => { const clock = new FakeClock(); return { clock, backend: new ScriptedBackend(clock), abort: new AbortController() }; };
const decoded = (audio: BackendAudio) => {
  const view = new DataView(audio.bytes.buffer, audio.bytes.byteOffset, audio.bytes.byteLength);
  expect(new TextDecoder().decode(audio.bytes.slice(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(audio.bytes.slice(8, 16))).toBe("WAVEfmt ");
  expect(view.getUint16(20, true)).toBe(1); expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint16(34, true)).toBe(16); expect(view.getUint32(40, true)).toBe(audio.bytes.length - 44);
  return { samples: (audio.bytes.length - 44) / 2, duration: (audio.bytes.length - 44) / 2 * 1000 / view.getUint32(24, true) };
};
test("backend (a) per-request latency", async () => {
  const { clock, backend, abort } = setup(); backend.script([audioStep()]);
  let result: BackendAudio | undefined;
  const pending = backend.synthesizeRequest({ text: "synthetic" }, abort.signal).then(a => { result = a; });
  await clock.advance(9); expect(result).toBeUndefined();
  await clock.advance(1); await pending; expect(result?.samples).toBe(100);
});
test("backend (b) scripted failure", async () => {
  const { clock, backend, abort } = setup(); backend.script([{ latency_ms: 4, late_after_cancel: false, result: { kind: "error", code: "SYNTH_FAILED" } }]);
  const pending = backend.synthesizeRequest({}, abort.signal).catch(e => e.message);
  await clock.advance(4); expect(await pending).toBe("SYNTH_FAILED");
});
test("backend (c) result arrives after cancel", async () => {
  const { clock, backend, abort } = setup(); backend.script([audioStep(pcmAudio(21), 10, true)]);
  const events: Json[] = [];
  const pending = backend.synthesizeRequest({}, abort.signal).then(a => events.push({ samples: a.samples, at: clock.now() }), () => events.push("rejected"));
  clock.schedule(2, () => { abort.abort(); events.push({ cancel: clock.now() }); });
  await clock.advance(9); expect(events).toEqual([{ cancel: 2 }]);
  await clock.advance(1); await pending; expect(events).toEqual([{ cancel: 2 }, { samples: 21, at: 10 }]);
});
test("backend ordinary cancellation and pre-aborted request reject without late delivery", async () => {
  for (const before of [true, false]) {
    const { clock, backend, abort } = setup(); backend.script([audioStep()]);
    if (before) abort.abort();
    const pending = backend.synthesizeRequest({}, abort.signal).catch(e => e.message);
    abort.abort(); await clock.advance(20); expect(await pending).toBe("cancelled");
  }
});
test("backend (d) claimed duration differs from decoded PCM", async () => {
  const { clock, backend, abort } = setup(); backend.script([audioStep(pcmAudio(125, 1000, 900))]);
  const pending = backend.synthesizeRequest({}, abort.signal); await clock.advance(10); const audio = await pending;
  expect(decoded(audio)).toEqual({ samples: 125, duration: 125 }); expect(audio.duration_ms).toBe(900);
});
test("backend (e) identical requests return different decoded lengths", async () => {
  const { clock, backend, abort } = setup(); backend.script([audioStep(pcmAudio(20)), audioStep(pcmAudio(40))]);
  const first = backend.synthesizeRequest({ text: "same" }, abort.signal), second = backend.synthesizeRequest({ text: "same" }, abort.signal);
  await clock.advance(10); expect(decoded(await first).samples).toBe(20); expect(decoded(await second).samples).toBe(40);
  expect(backend.calls).toEqual([{ text: "same" }, { text: "same" }]);
});
test("backend (f) no timings remains absent", async () => {
  const { clock, backend, abort } = setup(); backend.script([audioStep(), audioStep(pcmAudio(100, 1000, 100, [{ start_ms: 0, end_ms: 100 }]))]);
  const absent = backend.synthesizeRequest({}, abort.signal), present = backend.synthesizeRequest({}, abort.signal);
  await clock.advance(10); expect((await absent).timings).toBeNull(); expect((await present).timings).toEqual([{ start_ms: 0, end_ms: 100 }]);
});
const identity = { session_id: "s1", piece_index: 0, control_epoch: 1, text: "must not enter edges" };
const playerStep = { argv: ["fake-player", "synthetic.wav"], first_sample_ms: 2, first_audible_ms: 3, last_sample_ms: 8, exit_ms: 10, exit_code: 0 };
test("player edges have contract order, identity, source and fake times", async () => {
  const clock = new FakeClock(), player = new ScriptedPlayer(clock); player.script([playerStep]);
  const id = player.play(identity); await clock.advance(10);
  const expected = ["player_spawned", "first_sample", "first_audible", "last_sample", "player_exited"];
  expect(player.edges).toEqual(expected.map((edge, i) => ({ session_id: "s1", piece_index: 0, control_epoch: 1, player_instance_id: id, edge, t_mono_ms: [0, 2, 3, 8, 10][i], source: "player_reported", ...(i === 4 ? { exit_code: 0, status: "completed" } : {}) })));
  expect(player.spawn.calls).toEqual([playerStep.argv]);
});
test("player validates order and keeps ties ordered", async () => {
  const clock = new FakeClock(), player = new ScriptedPlayer(clock);
  expect(() => player.script([{ ...playerStep, first_sample_ms: 4 }])).toThrow("unordered");
  player.script([{ ...playerStep, first_sample_ms: 0, first_audible_ms: 0, last_sample_ms: 0, exit_ms: 0 }]);
  player.play(identity); await clock.advance(0); expect(player.edges).toHaveLength(5);
  expect(player.edges).toEqual(["player_spawned", "first_sample", "first_audible", "last_sample", "player_exited"].map(edge => expect.objectContaining({ edge, t_mono_ms: 0 })));
});
test("killed player exits once and cancels future sample edges", async () => {
  for (const at of [0, 2, 3, 8, 10]) {
    const clock = new FakeClock(), player = new ScriptedPlayer(clock); player.script([playerStep]);
    const id = player.play(identity); await clock.advance(at); player.stop(id); player.stop(id); await clock.advance(20);
    const prefix = ["player_spawned", ...[2 <= at ? "first_sample" : "", 3 <= at ? "first_audible" : "", 8 <= at ? "last_sample" : ""].filter(Boolean), "player_exited"];
    expect(player.edges).toEqual(prefix.map(edge => expect.objectContaining({ edge })));
    expect(player.edges.at(-1)).toEqual(expect.objectContaining({ exit_code: at < 10 ? 137 : 0, status: at < 10 ? "interrupted" : "completed" }));
  }
});
test("spawn records argv, scripted exit code and idempotent kill", async () => {
  const clock = new FakeClock(), spawn = new ScriptedSpawn(clock); spawn.script([{ exit_ms: 7, exit_code: 9 }, { exit_ms: 8, exit_code: 0 }]);
  const first = spawn.start(["fake", "one"]), killed = spawn.start(["fake", "two"]); killed.kill(); killed.kill();
  await clock.advance(6); let exited = false; void first.exited.then(() => { exited = true; }); await Promise.resolve(); expect(exited).toBe(false);
  await clock.advance(1); expect(await first.exited).toBe(9); expect(await killed.exited).toBe(137); await clock.advance(20);
  expect(spawn.calls).toEqual([["fake", "one"], ["fake", "two"]]);
});
test("host skeleton sends capture, permits, revokes and loans on the fake clock", async () => {
  const clock = new FakeClock(), messages: Json[] = [], host = new ScriptedHost(clock, m => messages.push(m));
  clock.schedule(2, () => host.capture("requested")); clock.schedule(3, () => host.capture("active"));
  clock.schedule(4, () => host.revoke("s1")); clock.schedule(5, () => host.loan("loan-1", "s1"));
  clock.schedule(6, () => host.capture("idle")); clock.schedule(7, () => host.permit("s1"));
  host.script([{ delay_ms: 8, message: { type: "custom", value: 1 } }]);
  await clock.advance(1); expect(host.records).toEqual([]); await clock.advance(7);
  expect(messages).toEqual([
    { protocol: "nl.engine/1", type: "capture_state", admission_epoch: 1, capture: "requested" },
    { protocol: "nl.engine/1", type: "capture_state", admission_epoch: 2, capture: "active" },
    { protocol: "nl.engine/1", type: "speaker_revoke", admission_epoch: 3, reason: "capture" },
    { protocol: "nl.engine/1", type: "loan_restore", loan_id: "loan-1", session_id: "s1" },
    { protocol: "nl.engine/1", type: "capture_state", admission_epoch: 4, capture: "idle" },
    { protocol: "nl.engine/1", type: "speaker_grant", admission_epoch: 5, permit_id: "permit-1", session_id: "s1", scope: "session" },
    { type: "custom", value: 1 },
  ]);
  expect(host.records).toEqual(messages.map((message, i) => ({ message, t_mono_ms: i + 2 })));
});
test("same scripts give byte-identical request, audio, host and edge digests without wall time", async () => {
  const run = async () => {
    const { clock, backend, abort } = setup(), player = new ScriptedPlayer(clock), host = new ScriptedHost(clock);
    backend.script([audioStep()]); player.script([playerStep]); host.capture("idle"); player.play(identity);
    const request = { text: "synthetic" }, pending = backend.synthesizeRequest(request, abort.signal); request.text = "mutated";
    await clock.advance(10); const audio = await pending;
    return createHash("sha256").update(JSON.stringify({ calls: backend.calls, audio: { ...audio, bytes: [...audio.bytes] }, edges: player.edges, argv: player.spawn.calls, host: host.records })).digest("hex");
  };
  await withoutWallTime(async () => { expect(await run()).toBe(await run()); }, violated => expect(violated).toBe(false));
});
test("fakes have no real I/O, timers or clocks", () => {
  for (const file of ["fake-backend", "fake-player", "host-stub"]) {
    const source = readFileSync(new URL(`../../src/engine/conformance/${file}.ts`, import.meta.url), "utf8");
    expect(source).not.toMatch(/node:(child_process|net|http|fs)|from\s*["']bun["']|\bBun\s*\.|\b(setTimeout|setInterval|setImmediate|Date|performance)\b/);
  }
});

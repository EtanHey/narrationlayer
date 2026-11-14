import type { Case, CaseContext } from "./runner";
import type { Json } from "./binding";
import { setup, success } from "./engine-cases";
import { pcmAudio } from "./fake-backend";
type Rig = ReturnType<typeof setup>;
type Owner = "user" | "f5" | "ask";
const text = "Amber rafts float. Violet cranes glide. Golden otters swim. Copper boats drift. Silver herons wade. Crimson foxes rest.";
const tick = async (t: Rig, n = 24) => { for (let i = 0; i < n; i++) await t.settle(1); };
async function start(c: CaseContext, early = false, count = 6) {
  const t = setup(c, Array.from({ length: count }, () => ({ latency_ms: 2, late_after_cancel: false, result: { kind: "audio" as const, ...pcmAudio(100) } })));
  t.connection.send({ protocol: "nl.engine/1", type: "narrate", request_id: "park-read", idempotency_key: "park-read", use: "read", input: { text, format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces" });
  await t.settle();
  const admission = t.seen.find(e => e.type === "accepted");
  c.assert(admission?.type === "accepted"); // L137: admission supplies the session.
  if (admission?.type !== "accepted") throw Error("missing admission");
  if (!early) await tick(t);
  return { ...t, id: admission.session_id };
}
type ParkRig = Awaited<ReturnType<typeof start>>;
async function control(c: CaseContext, t: ParkRig, op: "pause" | "resume", owner: Owner, extra: Record<string, Json> = {}) {
  const command_id = `park-${t.seen.length}`;
  t.connection.send({ protocol: "nl.engine/1", type: "control", session_id: t.id, command_id, op, args: { owner }, ...extra }); await t.settle();
  const acks = t.seen.filter(e => e.type === "control_ack" && e.command_id === command_id);
  c.assert(acks.length === 1); // L172: exactly one response per control.
  const ack = acks[0]; if (!ack || ack.type !== "control_ack") throw Error("missing ack"); return ack;
}
function feedback(c: CaseContext, t: ParkRig, index: number, epoch = index + 1, edges = ["spawned", "first_sample", "last_sample", "exited"]) {
  for (const edge of edges) t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: t.id, piece_index: index, control_epoch: epoch, player_instance_id: `park-player-${index}`, edge, t_mono_ms: c.clock.now(), source: "player_reported", ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: (index + 1) * 100 } } : {}) });
}
async function window(c: CaseContext, t: ParkRig, playing: number) {
  await tick(t, 100);
  const plan = t.seen.find(e => e.type === "plan");
  c.assert(plan?.type === "plan" && plan.pieces.length === 6); // L76: compare with the received plan.
  if (plan?.type !== "plan") throw Error("missing plan");
  const allowed = plan.pieces.filter(p => p.index <= playing + 2);
  c.assert(t.seen.filter(e => e.type === "piece_ready").every(p => allowed.some(a => a.index === p.index))); // L76 / ruling 62.
  c.assert(t.backend.calls.every(call => call !== null && typeof call === "object" && !Array.isArray(call) && allowed.some(p => p.index === call.piece_index))); // L76: synthesis, not only delivery.
}
async function complete(c: CaseContext, t: ParkRig) {
  for (let i = 0; i < 6; i++) { feedback(c, t, i, i + 4); await tick(t); }
  await t.finish(); success(c, t.seen, "park-read", 6, t.backend.calls); // L515-517: shared natural-end receipt.
}
export const pauseCases: Record<string, Case> = {
  "PAUSE-01e": async c => {
    const t = await start(c); feedback(c, t, 0, 1, ["spawned", "first_sample"]); await t.settle();
    const ack = await control(c, t, "pause", "user", { expected_control_epoch: 1 });
    c.assert(ack.outcome === "accept" && ack.control_epoch === 1); // L162, ruling 61: host epoch retained.
    await window(c, t, 0);
    await control(c, t, "resume", "user"); feedback(c, t, 0, 3, ["spawned", "first_sample"]); await t.settle();
    const staleInputs: Record<string, Json>[] = [{ expected_control_epoch: 1 }, { player_instance_id: "wrong-player" }];
    for (const extra of staleInputs) {
      const stale = await control(c, t, "pause", "ask", extra);
      c.assert(stale.outcome === "reject" && stale.reason === "STALE_EPOCH" && stale.current?.control_epoch === 3 && stale.current.piece_index === 0 && stale.current.player_instance_id === "park-player-0"); // L172.
      c.assert((await control(c, t, "resume", "ask")).outcome === "noop"); // Ruling 58: rejected pause never takes ownership.
    }
    await complete(c, t);
  },
  "PAUSE-02e": async c => {
    const t = await start(c, false, 3);
    c.assert((await control(c, t, "pause", "f5")).outcome === "accept"); // Ruling 58.
    const takeover = await control(c, t, "pause", "user");
    c.assert(takeover.outcome === "accept" && takeover.reason === "manual pause"); // L162.
    const rejected = await control(c, t, "resume", "f5");
    c.assert(rejected.outcome === "reject" && rejected.reason === "pause owner differs" && rejected.current === undefined); // Ruling 59.
    await tick(t, 100);
    c.assert(!t.seen.some(e => (e.type === "error" || e.type === "outcome") && e.session_id === t.id)); // Ruling 59: rejection alone.
    c.assert((await control(c, t, "resume", "user")).outcome === "accept"); // Ruling 59: rejected resume preserved manual ownership.
    t.connection.send({ protocol: "nl.engine/1", type: "control", session_id: t.id, command_id: "park-stop", op: "stop", args: { scope: "session", reason: "stop" } }); await tick(t);
    const end = t.seen.findIndex(e => e.type === "outcome" && e.session_id === t.id);
    c.assert(end >= 0 && !t.seen.slice(end + 1).some(e => "session_id" in e && e.session_id === t.id)); // L516: single final outcome.
    await t.finish();
    for (const owner of ["f5", "ask", "user"] as const) {
      const u = await start(c);
      c.assert((await control(c, u, "resume", owner)).outcome === "noop"); // Ruling 59.
      await control(c, u, "pause", owner);
      for (const other of ["user", "f5", "ask"] as const) if (other === owner || other !== "user") {
        c.assert((await control(c, u, "pause", other)).outcome === "noop"); // Ruling 58: first park retained except manual takeover.
      }
      if (owner === "ask") c.assert((await control(c, u, "resume", "f5")).outcome === "reject"); // L516.
      c.assert((await control(c, u, "resume", owner)).outcome === "accept"); // Ruling 59: noop preserved owner.
      await complete(c, u);
    }
  },
  "PAUSE-03e": async c => {
    for (const owner of ["user", "f5", "ask"] as const) {
      const t = await start(c, true);
      c.assert(!t.seen.some(e => e.type === "piece_ready")); // L517: before first audio.
      c.assert((await control(c, t, "pause", owner)).outcome === "accept"); // L517 / ruling 60.
      await window(c, t, 0);
      c.assert(t.seen.some(e => e.type === "piece_ready" && e.index === 0)); // Ruling 62: pause does not cancel first synthesis.
      c.assert((await control(c, t, "resume", owner)).outcome === "accept"); // Ruling 59.
      await complete(c, t);
    }
  },
};

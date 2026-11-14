import type { Case, CaseContext } from "./runner";
import type { Json } from "./binding";
import { setup } from "./engine-cases";
import { pcmAudio } from "./fake-backend";
type Rig = ReturnType<typeof setup> & { id: string };
async function until(t: ReturnType<typeof setup>, predicate: () => boolean) {
  for (let i = 0; i < 256 && !predicate(); i++) await t.settle(1);
  if (!predicate()) throw Error("seek event unavailable");
}
async function start(c: CaseContext, early = false): Promise<Rig> {
  const t = setup(c, Array.from({ length: 8 }, (_, index) => ({ latency_ms: index === 0 && early ? 1000 : index === 3 ? 50 : 2, late_after_cancel: false, result: { kind: "audio" as const, ...pcmAudio(100) } })));
  t.connection.send({ protocol: "nl.engine/1", type: "narrate", request_id: "seek-read", idempotency_key: "seek-read", use: "read", input: { text: "Azure lanterns glow. Copper rivers flow. Violet kites soar. Silver branches sway. Amber boats drift. Golden pebbles shine. Crimson foxes leap. Pearl clouds wander.", format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", lookahead: 2 });
  await until(t, () => t.seen.some(e => early ? e.type === "accepted" : e.type === "piece_ready" && e.index === 2));
  const a = t.seen.find(e => e.type === "accepted");
  if (!a || a.type !== "accepted") throw Error("seek admission unavailable");
  return { ...t, id: a.session_id };
}
async function control(t: Rig, op: string, args: Json, extra: Record<string, Json> = {}) {
  const command_id = `seek-command-${t.seen.length}`;
  t.connection.send({ protocol: "nl.engine/1", type: "control", session_id: t.id, command_id, op, args, ...extra });
  await until(t, () => t.seen.some(e => e.type === "control_ack" && e.command_id === command_id));
  const ack = t.seen.find(e => e.type === "control_ack" && e.command_id === command_id);
  if (!ack || ack.type !== "control_ack") throw Error("seek ack unavailable");
  return ack;
}
function feedback(c: CaseContext, t: Rig, piece: number, epoch: number, edge = "spawned") {
  t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: t.id, piece_index: piece, control_epoch: epoch, player_instance_id: `seek-player-${epoch}`, edge, t_mono_ms: c.clock.now(), source: "player_reported", ...(edge === "exited" ? { exit: { status: "failed", stopped_at_ms: 0 } } : {}) });
}
const pieces = (t: Rig) => t.seen.filter(e => e.type === "piece_ready");
async function quiet(t: Rig) { for (let i = 0; i < 32; i++) await t.settle(1); }
export const seekCases: Record<string, Case> = {
  "SEEK-01e": async c => {
    const t = await start(c);
    c.assert((await control(t, "seek", { audio_ms: 0 })).outcome === "accept"); // Ruling 77: before first_sample.
    feedback(c, t, 0, 1); feedback(c, t, 0, 1, "first_sample");
    const p = pieces(t)[1], word = p.words[1];
    const ack = await control(t, "seek", { word_index: word.index });
    c.assert(ack.outcome === "accept" && ack.offset_ms === word.start_ms); // L164, ruling 73.
    const plan = t.seen.find(e => e.type === "plan");
    if (!plan || plan.type !== "plan") throw Error("seek plan unavailable");
    const unavailable = await control(t, "seek", { word_index: plan.pieces[5].word_start });
    c.assert(unavailable.outcome === "reject" && unavailable.reason === "word timing unavailable"); // Ruling 72.
    await quiet(t);
    c.assert(pieces(t).every(p => p.index <= 3)); // L76, ruling 72: reject preserves the accepted landing at piece 1.
    await until(t, () => pieces(t).some(p => p.index === 3));
    const firstUndelivered = plan.pieces[pieces(t).length];
    const boundary = await control(t, "seek", { word_index: firstUndelivered.word_start });
    c.assert(boundary.outcome === "reject" && boundary.reason === "word timing unavailable"); // Ruling 72: first unavailable word too.
    await quiet(t);
    c.assert(pieces(t).every(p => p.index <= 3)); // L76: another reject cannot enlarge the window.
    const stale = await control(t, "seek", { audio_ms: pieces(t).at(-1)!.start_ms }, { expected_control_epoch: ack.control_epoch + 1000 });
    c.assert(stale.outcome === "reject" && stale.reason === "STALE_EPOCH" && stale.current?.piece_index === 1); // L158/L172: stale seek carries unchanged mirror.
    await quiet(t);
    c.assert(pieces(t).every(p => p.index <= 3)); // L76: stale seek cannot move pacing.
    c.assert((await control(t, "seek", { word_index: plan.words.length })).reason === "word index out of range"); // Ruling 72.
    const clamped = await control(t, "seek", { audio_ms: 999999 });
    const prefix = t.seen.slice(0, t.seen.indexOf(clamped)).filter(e => e.type === "piece_ready").at(-1)!;
    c.assert(clamped.outcome === "accept" && clamped.clamped === true && clamped.offset_ms === prefix.start_ms + prefix.duration_ms); // L172, ruling 73.
    await until(t, () => pieces(t).some(p => p.index === prefix.index + 2));
    await control(t, "seek", { word_index: word.index }); await quiet(t);
    c.assert(pieces(t).every(p => p.index <= prefix.index + 2) && new Set(pieces(t).map(p => p.index)).size === pieces(t).length); // L76, ruling 74: no new delivery beyond landing window, no replay synthesis.
    const negative = await control(t, "seek", { audio_ms: -1 });
    c.assert(negative.outcome === "reject" && negative.reason === "invalid offset"); // Ruling 73.
    c.assert(t.backend.calls.every(call => call !== null && typeof call === "object" && !Array.isArray(call) && Number(call.piece_index) <= prefix.index + 2)); // L76, ruling 74: synthesis stays in the window.
    await control(t, "pause", { owner: "ask" });
    c.assert((await control(t, "seek", { word_index: word.index })).outcome === "accept"); // Ruling 75.
    c.assert((await control(t, "resume", { owner: "f5" })).outcome === "reject"); // Ruling 75: owner preserved.
    c.assert((await control(t, "resume", { owner: "ask" })).outcome === "accept"); // I09, ruling 75.
    for (let i = 2; i <= 5; i++) { feedback(c, t, i, 18 + i); await until(t, () => pieces(t).some(p => p.index === Math.min(7, i + 2))); }
    await until(t, () => pieces(t).some(p => p.index === 7));
    await control(t, "stop", { scope: "session", reason: "stop" });
    await until(t, () => t.seen.some(e => e.type === "outcome"));
    c.assert((await control(t, "seek", { audio_ms: 0 })).outcome === "noop"); // Existing terminal precedence: ended seek changes nothing.
    const endedNegative = await control(t, "seek", { audio_ms: -1 });
    c.assert(endedNegative.outcome === "reject" && endedNegative.reason === "invalid offset"); // Amended ruling 73: negative precedes ended.
    await t.finish();
    const early = await start(c, true);
    c.assert(pieces(early).length === 0); // Ruling 77: fixture is still preparing.
    const preparingNegative = await control(early, "seek", { audio_ms: -1 });
    c.assert(preparingNegative.outcome === "reject" && preparingNegative.reason === "invalid offset"); // Ruling 73: negative precedes not ready.
    const preparingArgs: Json[] = [{ audio_ms: 0 }, { audio_ms: 50 }, { word_index: 0 }];
    for (const args of preparingArgs) {
      const notReady = await control(early, "seek", args);
      c.assert(notReady.outcome === "noop" && notReady.reason === "not ready"); // Amended ruling 77.
    }
    for (let i = 0; i < 4 && !pieces(early).some(p => p.index === 2); i++) await until(early, () => pieces(early).some(p => p.index === 2)).catch(() => {});
    await until(early, () => pieces(early).some(p => p.index === 2));
    for (let index = 0; index < 6; index++) { feedback(c, early, index, 30 + index); await until(early, () => pieces(early).some(p => p.index === Math.min(7, index + 2))); }
    await early.finish();
  },
  "ID-01e": async c => {
    const t = await start(c); feedback(c, t, 0, 1); feedback(c, t, 0, 1, "first_sample");
    const ack = await control(t, "seek", { word_index: pieces(t)[1].words[0].index });
    c.assert(ack.outcome === "accept"); // L164.
    const epoch = Math.max(2, ack.control_epoch + 1); feedback(c, t, 1, epoch); await t.settle();
    const before = t.seen.length; feedback(c, t, 0, 1, "exited");
    await until(t, () => t.seen.slice(before).some(e => e.type === "error"));
    c.assert(t.seen.slice(before).some(e => e.type === "error" && e.code === "STALE_EPOCH" && e.phase === "deliver")); // L281, ID-01 L479.
    c.assert(!t.seen.some(e => e.type === "outcome")); // L281: stale exit cannot terminate.
    feedback(c, t, 2, epoch + 1);
    await until(t, () => pieces(t).some(p => p.index === 4));
    c.assert(pieces(t).some(p => p.index === 4) && pieces(t).every(p => p.index <= 4)); // L76, ruling 74: new player drives pacing.
    for (let i = 2; i <= 5; i++) { feedback(c, t, i, 18 + i); await until(t, () => pieces(t).some(p => p.index === Math.min(7, i + 2))); }
    await until(t, () => pieces(t).some(p => p.index === 7));
    await t.finish();
  },
};

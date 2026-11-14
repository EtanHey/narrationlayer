import type { Case, CaseContext } from "./runner";
import { setup, until } from "./engine-cases";
import { pcmAudio } from "./fake-backend";
import type { Event, Message } from "../messages/messages";
import type { Json } from "./binding";
type Rig = ReturnType<typeof setup>;
const stable = (value: unknown) => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
const pieces = (t: Rig, id: string) => t.seen.filter((e): e is Message<"piece_ready"> => e.type === "piece_ready" && e.session_id === id);
function feed(c: CaseContext, t: Rig, id: string, index: number, edge: string, epoch = 7) {
  t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: id, piece_index: index,
    player_instance_id: `resync-player-${index}`, control_epoch: epoch, edge, t_mono_ms: c.clock.now(), source: "player_reported",
    ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: (index + 1) * 100 } } : {}) });
}
async function command(c: CaseContext, t: Rig, id: string, op: string, args: Json = {}, extra: Record<string, Json> = {}) {
  const command_id = `resync-command-${t.seen.length}`;
  const message = { protocol: "nl.engine/1", type: "control", session_id: id, command_id, op, args, ...extra };
  t.connection.send(message);
  await until(c, () => t.seen.some(e => e.type === "control_ack" && e.command_id === command_id));
  const ack = t.seen.find(e => e.type === "control_ack" && e.command_id === command_id);
  if (!ack || ack.type !== "control_ack") throw Error("missing control ack");
  return { message, ack };
}
async function read(c: CaseContext, t: Rig, name: string, after?: string) {
  t.connection.send({ protocol: "nl.engine/1", type: "narrate", request_id: name, idempotency_key: name, use: "read",
    input: { text: after ? "Ivory boats drift." : "Copper kites soar. Violet rivers flow.", format: "plain" },
    voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", lookahead: 1,
    ...(after ? { start: { after_session: after } } : {}) });
  await until(c, () => t.seen.some(e => e.type === "plan" && t.seen.some(a => a.type === "accepted" && a.request_id === name && a.session_id === e.session_id)));
  const a = t.seen.find(e => e.type === "accepted" && e.request_id === name);
  if (!a || a.type !== "accepted") throw Error("missing admission");
  return a.session_id;
}
async function fixture(c: CaseContext) {
  const t = setup(c, Array.from({ length: 5 }, () => ({ latency_ms: 2, late_after_cancel: false, result: { kind: "audio" as const, ...pcmAudio(100) } })));
  const id = await read(c, t, "resync-playing");
  await until(c, () => pieces(t, id).length === 2);
  feed(c, t, id, 0, "spawned"); feed(c, t, id, 0, "first_sample");
  const queued = await read(c, t, "resync-queued", id);
  const ended = await read(c, t, "resync-ended");
  await until(c, () => pieces(t, queued).length === 1 && pieces(t, ended).length === 2);
  await command(c, t, ended, "stop", { scope: "session", reason: "stop" });
  await until(c, () => t.seen.some(e => e.type === "outcome" && e.session_id === ended));
  return { t, id, queued };
}
function body(e: Exclude<Event, Message<"welcome">>) { const { seq, ...rest } = e; return rest; }
async function snapshot(c: CaseContext, t: Rig, id: string, queued: string) {
  const { ack } = await command(c, t, id, "resync");
  await until(c, () => t.seen.some(e => e.type === "snapshot"));
  const snap = t.seen.find(e => e.type === "snapshot");
  if (!snap || snap.type !== "snapshot") throw Error("missing snapshot");
  const before = t.seen.slice(0, t.seen.indexOf(snap));
  c.assert(ack.outcome === "accept" && before.at(-1) === ack); // L168, ruling 87: addressed ack before connection snapshot.
  c.assert(equal(snap.sessions.map(s => s.session_id).sort(), [id, queued].sort())); // Rulings 85/87: exactly the live sessions; snapshot list order is unrestricted.
  const expected: Event[] = [];
  for (const [i, session_id] of [id, queued].entries()) {
    const plan = before.find(e => e.type === "plan" && e.session_id === session_id);
    if (!plan || plan.type !== "plan") throw Error("missing initial plan");
    const delivered = pieces({ ...t, seen: before }, session_id);
    const last = before.filter(e => "session_id" in e && e.session_id === session_id).at(-1);
    const seq = session_id === id ? ack.seq : last && "seq" in last ? last.seq : 0;
    c.assert(equal(snap.sessions.find(s => s.session_id === session_id), { session_id, request_id: i ? "resync-queued" : "resync-playing",
      phase: i ? "preparing" : "playing", control_epoch: i ? 0 : 7, player_instance_id: i ? "" : "resync-player-0",
      audio_ms: 0, word_index: 0, pieces_ready: delivered.length, last_seq: seq })); // Ruling 86: observed deliveries and mirror feedback.
    expected.push(plan, ...delivered.map(p => ({ protocol: p.protocol, owner_epoch: p.owner_epoch, seq: 0, type: "timing_update" as const,
      session_id, attempt_id: p.attempt_id, piece_id: p.piece_id, derivation_id: "resync", words: p.words })));
  }
  await until(c, () => t.seen.length >= t.seen.indexOf(snap) + 1 + expected.length);
  const replayed = t.seen.slice(t.seen.indexOf(snap) + 1, t.seen.indexOf(snap) + 1 + expected.length);
  c.assert(equal(replayed.map(e => e.type === "welcome" ? e : body(e)), expected.map(e => e.type === "welcome" ? e : body(e)))); // L190, ruling 83: plans and delivered words, no piece or lease redelivery.
}
async function scenario(c: CaseContext, sequence: boolean) {
  const { t, id, queued } = await fixture(c);
  await snapshot(c, t, id, queued);
  const pause = await command(c, t, id, "pause", { owner: "user" });
  t.connection.send(pause.message);
  await until(c, () => t.seen.filter(e => e.type === "control_ack" && e.command_id === pause.ack.command_id).length === 2);
  const replay = t.seen.filter(e => e.type === "control_ack" && e.command_id === pause.ack.command_id).at(-1);
  c.assert(equal(replay, pause.ack)); // L158, rulings 84/88: replay preserves the first ack including seq.
  await command(c, t, id, "resume", { owner: "user" });
  for (let index = 0; index < 2; index++) {
    feed(c, t, id, index, "spawned", 8 + index); feed(c, t, id, index, "first_sample", 8 + index); feed(c, t, id, index, "exited", 8 + index);
  }
  await until(c, () => t.seen.some(e => e.type === "outcome" && e.session_id === id));
  await until(c, () => pieces(t, queued).length === 1);
  feed(c, t, queued, 0, "spawned"); feed(c, t, queued, 0, "first_sample"); feed(c, t, queued, 0, "exited");
  await until(c, () => t.seen.some(e => e.type === "outcome" && e.session_id === queued));
  const piece = pieces(t, id)[0];
  t.connection.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: piece.artifact.lease_id });
  await command(c, t, id, "stop", { scope: "session", reason: "stop" }); // Barrier after release.
  await t.finish();
  c.assert(t.seen.filter(e => e.type === "snapshot").length === 1); // Ruling 87: one snapshot per fresh resync.
  const all = t.seen.filter(e => e.type === "piece_ready");
  c.assert(new Set(all.map(p => `${p.session_id}:${p.index}`)).size === all.length); // L114, ruling 83: no repeated delivery, including late duplicates.
  if (sequence) {
    let seq = 0;
    for (const event of t.seen) if ("seq" in event) {
      if (event === replay) continue;
      c.assert(event.seq === ++seq); // L114, rulings 84/88: every fresh connection event gets the next seq.
    }
  }
}
export const resyncCases: Record<string, Case> = {
  "SNAP-01": c => scenario(c, false),
  "SEQ-01": c => scenario(c, true),
  "STALE-01": async c => {
    const { t, id } = await fixture(c);
    for (const [op, args] of [["pause", { owner: "user" }], ["resume", { owner: "user" }], ["seek", { audio_ms: 0 }]] as const) {
      const { ack } = await command(c, t, id, op, args, { expected_control_epoch: 6 });
      c.assert(ack.outcome === "reject" && ack.reason === "STALE_EPOCH"); // L172, ruling 88.
      c.assert(equal(ack.current, { session_id: id, player_instance_id: "resync-player-0", control_epoch: 7,
        audio_ms: 0, piece_index: 0, piece_start_ms: 0, piece_duration_ms: 0, duration_ms: pieces(t, id).at(-1)!.start_ms + pieces(t, id).at(-1)!.duration_ms })); // L172, ruling 88: every field of the mirror position.
    }
    await t.finish();
  },
};

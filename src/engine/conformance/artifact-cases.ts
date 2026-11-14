import { createHash } from "node:crypto";
import type { Case, CaseContext } from "./runner";
import type { BackendStep, Json } from "./binding";
import type { Message } from "../messages/messages";
import { setup, success, interrupted } from "./engine-cases";
import { pcmAudio } from "./fake-backend";
const text = "Amber rafts float. Violet cranes glide. Golden otters swim.";
const read = (id: string): Json => ({ protocol: "nl.engine/1", type: "narrate", request_id: id, idempotency_key: id, use: "read", input: { text, format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", lookahead: 3 });
const script = (): BackendStep[] => [31, 47, 63].map(n => ({ latency_ms: 2, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(n, 1000, n) } }));
function fixture(c: CaseContext, steps = [...script(), ...script(), ...script().slice(0, 1), { latency_ms: 2, late_after_cancel: true, result: { kind: "audio", ...pcmAudio(79) } } satisfies BackendStep]) {
  let store = new Map<string, Uint8Array>();
  const create = c.binding.create;
  c.binding.create = host => { store = host.store; return create(host); };
  const t = setup(c, steps); c.binding.create = create;
  c.assert(typeof t.connection.resolve === "function");
  const released = new Set<string>();
  const pieces = () => t.seen.filter(e => e.type === "piece_ready");
  const release = async (p: Message<"piece_ready">) => {
    t.connection.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id: p.artifact.lease_id });
    await t.settle(); released.add(p.artifact.lease_id);
  };
  const check = () => {
    for (const p of pieces()) {
      const result = t.connection.resolve!(p.artifact.handle, p.artifact.lease_id);
      if (released.has(p.artifact.lease_id)) { c.assert(result.kind === "expired"); continue; }
      const expected = script()[p.index].result; c.assert(expected.kind === "audio");
      if (expected.kind !== "audio") continue;
      c.assert(result.kind === "resolved");
      if (result.kind !== "resolved") continue;
      c.assert(result.bytes.length === expected.bytes.length && result.bytes.every((v, i) => v === expected.bytes[i]));
      c.assert(p.artifact.sha256 === createHash("sha256").update(expected.bytes).digest("hex"));
      result.bytes.fill(0);
      const again = t.connection.resolve!(p.artifact.handle, p.artifact.lease_id);
      c.assert(again.kind === "resolved" && again.bytes.every((v, i) => v === expected.bytes[i]));
    }
  };
  const outcome = (id: string) => {
    const accepted = t.seen.find(e => e.type === "accepted" && e.request_id === id); c.assert(accepted?.type === "accepted");
    if (accepted?.type !== "accepted") return;
    const out = t.seen.filter(e => e.type === "outcome").filter(e => e.session_id === accepted.session_id); c.assert(out.length === 1);
    c.assert(JSON.stringify(out[0].artifacts) === JSON.stringify(pieces().filter(p => p.session_id === accepted.session_id && !released.has(p.artifact.lease_id)).map(p => ({ piece_id: p.piece_id, handle: p.artifact.handle, lease_id: p.artifact.lease_id }))));
  };
  const complete = async (id: string) => {
    for (let i = 0; i < 12; i++) await t.settle(1);
    const a = t.seen.find(e => e.type === "accepted" && e.request_id === id); c.assert(a?.type === "accepted");
    if (a?.type !== "accepted") return;
    for (const p of pieces().filter(p => p.session_id === a.session_id)) for (const edge of ["spawned", "first_sample", "exited"]) t.connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: p.session_id, player_instance_id: `artifact-player-${p.index}`, control_epoch: p.index + 1, piece_index: p.index, edge, t_mono_ms: c.clock.now(), ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: p.start_ms + p.duration_ms } } : {}) });
    await t.settle(); success(c, t.seen, id, 3, t.backend.calls); outcome(id);
  };
  return { ...t, pieces, release, check, complete, outcome, released, store };
}
export const artifactCases: Record<string, Case> = {
  "ART-01": async c => {
    const t = fixture(c); t.connection.send(read("artifact-first"));
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i < 8 && t.pieces().length < n; i++) await t.settle(1);
      c.assert(t.pieces().length === n); t.check();
      if (n === 2) { await t.release(t.pieces()[0]); c.assert(t.pieces().length === 2); t.check(); }
    }
    await t.complete("artifact-first"); t.check();
    t.connection.send(read("artifact-second")); await t.complete("artifact-second"); t.check();
    t.connection.send(read("artifact-stop"));
    for (let i = 0; i < 8 && t.pieces().length < 7; i++) await t.settle(1);
    c.assert(t.pieces().length === 7);
    const p = t.pieces()[6];
    t.connection.send({ protocol: "nl.engine/1", type: "control", command_id: "artifact-stop", session_id: p.session_id, op: "stop", args: { scope: "session", reason: "stop" } });
    await t.settle(3); interrupted(c, t.seen, "artifact-stop", 1, "cancelled", t.backend.calls); t.outcome("artifact-stop"); t.check();
    await t.finish(); t.check();
    c.assert(t.store.size === t.pieces().length - t.released.size);
    const live = fixture(c, [...script(), ...script()]);
    for (const id of ["artifact-first", "artifact-second"]) { live.connection.send(read(id)); await live.complete(id); }
    for (const p of live.pieces()) await live.release(p);
    live.check(); c.assert(live.store.size === 0); await live.finish();
  },
  "ART-04": async c => {
    const t = fixture(c, [...script(), ...script()]);
    t.connection.send(read("artifact-first"));
    for (let i = 0; i < 8 && t.pieces().length < 2; i++) await t.settle(1);
    c.assert(t.pieces().length === 2);
    const [a, b] = t.pieces();
    c.assert(t.connection.resolve!(b.artifact.handle, a.artifact.lease_id).kind === "expired"); t.check();
    const before = c.trace.length; await t.release(a); c.assert(c.trace.length === before); t.check();
    const expired = async (lease_id: string, known: boolean) => {
      const start = c.trace.length;
      t.connection.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id }); await t.settle();
      c.assert(c.trace.length === start + 1);
      const e = t.seen.at(-1); c.assert(e?.type === "error");
      if (e?.type !== "error") return;
      c.assert(e.code === "ARTIFACT_EXPIRED" && e.phase === "retain" && e.retry === "never" && e.session_id === undefined && e.request_id === undefined);
      c.assert(JSON.stringify(e.details) === (known ? JSON.stringify({ lease_id }) : undefined));
    };
    await expired(a.artifact.lease_id, true);
    const canary = "quartzFalconRiverMeadowX"; c.assert(canary.length === 24);
    await expired(canary, false);
    const raw = JSON.stringify(c.trace); for (let i = 0; i <= canary.length - 8; i++) c.assert(!raw.includes(canary.slice(i, i + 8)));
    // The shared success receipt rejects uncorrelated errors; check the deliberate refusals
    // separately above, then pass the successful read's complete session trace.
    const errors = t.seen.filter(e => e.type === "error"); t.seen.splice(0, t.seen.length, ...t.seen.filter(e => e.type !== "error"));
    await t.complete("artifact-first"); t.check();
    t.connection.send(read("artifact-second")); await t.complete("artifact-second");
    await t.release(b); t.check();
    for (const p of t.pieces()) if (!t.released.has(p.artifact.lease_id)) await t.release(p);
    t.check(); c.assert(t.store.size === 0); c.assert(errors.length === 2);
    await t.finish();
    c.assert(c.trace.filter(e => e && typeof e === "object" && !Array.isArray(e) && e.type === "error").length === 2);
  },
};

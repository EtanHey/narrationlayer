import { expect, test } from "bun:test";
import engine from "../../src/engine/conformance/engine-binding";
import { engineCases } from "../../src/engine/conformance/engine-cases";
import { runCase } from "../../src/engine/conformance/runner";
import type { Binding, Json } from "../../src/engine/conformance/binding";

function own(fault: string): Binding {
  return { name: `own-${fault}`, create(host) {
    const backend = host.ports?.backend, synthesize = backend?.synthesizeRequest.bind(backend);
    if (fault === "overlap" && backend && synthesize) backend.synthesizeRequest = (r, s) => { void synthesize(r, s).catch(() => {}); return synthesize(r, s); };
    const c = engine.create(host), sessions = new Set<string>(), stored = new Map<string, Json>(), owners = new Map<string, string>();
    let shift = 0, replay = false, lateExit = false; const halted = new Set<string>();
    return { shutdown: c.shutdown, send(m) {
      if (m && typeof m === "object" && !Array.isArray(m)) {
        if (m.type === "control" && m.op === "stop") halted.add(String(m.session_id));
        if (m.type === "player_feedback" && m.edge === "exited" && halted.has(String(m.session_id))) lateExit = true;
        if (fault === "ignore-lookahead" && m.type === "narrate") { const { lookahead, ...rest } = m; m = rest; }
        if (fault === "never-resume" && m.type === "player_feedback" && Number(m.piece_index) > 0) return;
        if (fault === "unknown-feedback-error" && m.type === "player_feedback" && !sessions.has(String(m.session_id))) m = { protocol: "nl.engine/1", type: "control", session_id: m.session_id, command_id: "feedback-error", op: "stop", args: { scope: "session", reason: "stop" } };
        if (fault === "close-unknown" && m.type === "control" && !sessions.has(String(m.session_id))) { c.send(m); void c.shutdown(host.clock.now()); return; }
        // A 31-entry cache has forgotten cmd-3 after cmd-34. Treat that retry as new.
        if (fault === "window-31" && m.type === "control" && m.command_id === "cmd-3" && stored.has("cmd-34")) m = { ...m, command_id: "cmd-3:forgotten" };
        if (m.type === "control") {
          if (fault === "shared-receipts" && owners.has(String(m.command_id)) && owners.get(String(m.command_id)) !== m.session_id) replay = true;
          if (!owners.has(String(m.command_id))) owners.set(String(m.command_id), String(m.session_id));
        }
      }
      c.send(m);
    }, events: (async function* (): AsyncGenerator<Json> {
      for await (const e of c.events) {
        if (e.type === "accepted") sessions.add(e.session_id);
        if (e.type === "control_ack") {
          if (fault === "shared-receipts" && replay && stored.has(e.command_id)) { replay = false; yield stored.get(e.command_id)!; continue; }
          stored.set(e.command_id, e);
          if (e.command_id === "cmd-3:forgotten") { yield { ...e, command_id: "cmd-3" }; continue; }
        }
        yield "seq" in e ? { ...e, seq: e.seq + shift } : e;
        if (fault === "late-second-outcome" && lateExit && e.type === "outcome" && e.playback.reason === "stop") { shift++; yield { ...e, seq: e.seq + shift }; }
      }
    })() };
  } };
}
for (const [fault, id] of [["overlap", "PACE-01"], ["never-resume", "PACE-01"], ["ignore-lookahead", "PACE-01"], ["window-31", "CTRL-01"], ["shared-receipts", "CTRL-01"], ["close-unknown", "SESS-01"], ["unknown-feedback-error", "SESS-01"], ["late-second-outcome", "ID-05e"]]) {
  test(`${id}: own wrong engine ${fault} is caught`, async () => expect((await runCase(id, own(fault), engineCases[id])).result).toBe("fail"));
}
test("all pacing and identity cases pass the unchanged engine", async () => {
  for (const id of ["PACE-01", "PACE-02", "CTRL-01", "SESS-01", "ID-05e"]) expect((await runCase(id, engine, engineCases[id])).result).toBe("pass");
});

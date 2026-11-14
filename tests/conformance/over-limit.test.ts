import { expect, test } from "bun:test";
import { runCase } from "../../src/engine/conformance/runner";
import { planningCases } from "../../src/engine/conformance/planning-cases";
import { createEngineSession } from "../../src/engine/session/session";
import { planRead } from "../../src/plan/read-plan";
import { createPublication } from "../../src/engine/publication/publication";
import { createArtifactStore } from "../../src/engine/artifacts/store";
import { ScriptedBackend } from "../../src/engine/conformance/fake-backend";
import oldRule from "../../src/engine/conformance/broken-over-limit";
import type { Binding } from "../../src/engine/conformance/binding";

function own(fault: string): Binding {
  return { name: `own-${fault}`, create(host) {
    const engine = { family: "edge", profile_revision: "synthetic-1", voice: "synthetic" };
    return createEngineSession({ clock: host.clock, backend: host.ports?.backend ?? new ScriptedBackend(host.clock), owner_epoch: 1,
      welcome: { package_version: "0.0.0-conformance", protocol_minor: 0,
        caps: ["read", "speak", "ask_prompt", "display_document", "word_timing", "lifecycle"],
        engines: [{ family: "edge", max_chars: fault === "large-limit" ? 1000 : 120, legacy: false, clone: false, timing: "none", cancel: "abort_only", available: true }] },
      limits: { max_chars: { read: 1000, speak: 900, ask_prompt: 800 }, lookahead: 2, aligner_reap_ms: 50 },
      publication: createPublication(createArtifactStore(host.store, 1)),
      planner: { plan(request, _limits, identity) {
        const d = planRead({ request, identity, engine, max_chars: fault === "large-limit" ? 1000 : 120 }), p = d.plan;
        const text = request.input.text;
        let changed = false;
        const move = (i: number, at: number) => {
          changed = true;
          p.pieces[i].word_end = at; p.pieces[i].segments[0].word_end = at;
          p.pieces[i + 1].word_start = at; p.pieces[i + 1].segments[0].word_start = at;
        };
        if (fault === "colon" && /^lantern(?: lantern){5}:/.test(text)) move(0, 6);
        if (fault === "tail" && text.length === 123 && text.endsWith("tail words.")) move(0, p.words.findIndex(w => w.text === "—") + 1);
        if (fault === "head" && text.startsWith("Lantern,") && text.length > 120) move(0, 1);
        if (fault === "unspaced" && text.includes("lamp—")) {
          const at = p.words.findIndex(w => w.text.includes("lamp—")), original = p.words[at];
          p.words.splice(at, 1, { ...original, text: "lamp—" }, { ...original, text: "lantern" });
          p.words.forEach((w, i) => w.index = i);
          p.pieces[1].word_end++; p.pieces[1].segments[0].word_end++;
          move(0, at + 1);
        }
        // In the 391-character fixture this word boundary produces 121 characters.
        if (fault === "limit-plus-one" && text.length === 391) move(0, 15);
        if (fault === "whole" && text.length === 176 && !text.includes(",")) {
          changed = true;
          p.pieces[0].word_end = p.words.length; p.pieces[0].segments[0].word_end = p.words.length;
          p.pieces.splice(1);
        }
        if (fault === "end-pause" && text.length === 235 && p.pieces.length === 4) {
          changed = true; p.pieces[2].segments[0].pause_after_ms = 0;
        }
        if (fault === "under-limit" && text.length === 150 && p.pieces.length === 3) {
          changed = true;
          const piece = p.pieces[1], at = piece.word_start + 6;
          p.pieces.splice(1, 1,
            { ...piece, word_end: at, segments: [{ ...piece.segments[0], word_end: at, pause_after_ms: 0 }] },
            { ...piece, word_start: at, segments: [{ ...piece.segments[0], word_start: at }] });
        }
        if (fault === "number-hyphen" && text.includes("pages 3- 4")) move(0, p.words.findIndex(w => w.text === "3-") + 1);
        if ((fault === "ignore-en" && text.includes("amber – tail")) || (fault === "ignore-bar" && text.includes("amber ― tail"))) move(0, p.words.length - 3);
        if (fault === "plain-pauses" && request.input.format === "plain") {
          changed = true; for (const piece of p.pieces) piece.segments[0].pause_after_ms = 0;
        }
        if (!changed) return d;
        p.pieces.forEach((piece, i) => { piece.index = i; piece.piece_id = `${identity.session_id}:own:${i}`; });
        // The session publishes these same requests, so faults cannot rely on a lying stream.
        d.requests = p.pieces.map(piece => ({ piece_index: piece.index, text: p.words.slice(piece.word_start, piece.word_end).map(w => w.text).join(" ") }));
        return d;
      } },
    });
  } };
}

for (const [fault, id] of [["number-hyphen", "PLAN-D4"], ["ignore-en", "PLAN-D4"], ["ignore-bar", "PLAN-D4"], ["plain-pauses", "PLAN-02"], ["plain-pauses", "PAUSE-PL-01"], ["large-limit", "PLAN-D4"], ["colon", "PLAN-D4"], ["tail", "PLAN-D5"], ["head", "PLAN-D5"], ["unspaced", "PLAN-D4"], ["limit-plus-one", "PLAN-D4"], ["whole", "PLAN-D4"], ["end-pause", "PLAN-02"], ["under-limit", "PLAN-02"]]) {
  test(`over-limit planning catches ${fault} with consistent backend requests`, async () => {
    expect((await runCase(id, own(fault), planningCases[id])).result).toBe("fail");
  });
}

test("own planning fault probes preserve the correct engine as a passing control", async () => {
  for (const id of ["PLAN-D4", "PLAN-D5", "PLAN-02"]) expect((await runCase(id, own("none"), planningCases[id])).result).toBe("pass");
});

test("old phrase rule is caught with matching plan, pieces and backend text", async () => {
  expect((await runCase("PLAN-D4", oldRule, planningCases["PLAN-D4"])).result).toBe("fail");
});

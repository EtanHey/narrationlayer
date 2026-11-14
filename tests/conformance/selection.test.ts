import { expect, test } from "bun:test";
import engine from "../../src/engine/conformance/engine-binding";
import { engineCases } from "../../src/engine/conformance/engine-cases";
import { runCase } from "../../src/engine/conformance/runner";
import type { Binding } from "../../src/engine/conformance/binding";
import { createEngineSession } from "../../src/engine/session/session";
import { createPublication } from "../../src/engine/publication/publication";
import { createArtifactStore } from "../../src/engine/artifacts/store";
import { parseVoices, selectVoice } from "../../src/engine/selection/voice";
import { planRead } from "../../src/plan/read-plan";
import { projectStructuredSpeech } from "../../src/text/voicelayer/structured-speech";
const delayed: Binding = { name: "conforming-delayed", create(host) {
  const connection = engine.create(host);
  return { ...connection, events: (async function* () {
    for await (const event of connection.events) { await new Promise<void>(resolve => host.clock.schedule(1, resolve)); yield event; }
  })() };
} };
const grouped: Binding = { name: "conforming-grouped", create(host) {
  if (!host.voices || !host.engines || !host.ports) throw new Error("selection fixtures supply host data");
  const voices = parseVoices(host.voices), engines = host.engines;
  return createEngineSession({ synthesis_timeout_ms: 10000, clock: host.clock, backend: host.ports.backend, owner_epoch: 1,
    welcome: { package_version: "synthetic", protocol_minor: 0, caps: ["read", "speak", "word_timing", "lifecycle"], engines },
    limits: { max_chars: { read: 1000, speak: 900, ask_prompt: 800 }, lookahead: 2, aligner_reap_ms: 50 },
    publication: createPublication(createArtifactStore(host.store, 1)), planner: { plan(request, _limits, identity) {
      const projection = request.input.format === "markdown" ? projectStructuredSpeech(request.input.text) : { displayText: request.input.text, speechText: request.input.text };
      const selection = selectVoice(request, projection.displayText, projection.speechText.replace(/ {2,}/g, " ").trim().length, voices, engines);
      const prepared = planRead({ request, identity, engine: selection.engine, max_chars: 120 });
      if (selection.engine.family === "edge" && prepared.plan.pieces.length > 1) {
        const pieces = prepared.plan.pieces;
        prepared.plan.pieces = [{ ...pieces[0], word_end: pieces.at(-1)!.word_end, segments: pieces.flatMap(p => p.segments) }];
        prepared.requests = [{ piece_index: 0, text: prepared.requests.map(r => r.text).join(" ") }];
      }
      return { ...prepared, selection };
    } },
  });
} };
test("selection cases accept delayed events and grouped Edge segments", async () => {
  for (const binding of [delayed, grouped]) for (const id of ["ENG-01", "SUB-01"])
    expect((await runCase(id, binding, engineCases[id])).result, `${binding.name} ${id}`).toBe("pass");
});

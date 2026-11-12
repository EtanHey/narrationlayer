import { expect, test } from "bun:test";
import { breathingV1, utterancesV1, toBreathingPieces, toPlannedUtterances } from "../../src/plan/index.js";
import { planNarrationUtterances } from "../../src/narration-plan.js";
import { splitForBreathing } from "../../src/plan/breathing.js";
import { splitForBreathing as binBreathing } from "../../bin/local-tts-runner.js";
import type { NarrationPacingConfig } from "../../src/plan/utterances.js";
import golden from "./fixtures/plan-pieces.golden.json";

// Captured before editing source at master d70dae1371e9ebe21d8386140e579223cfdc9164.
// Caller defaults: job {}, runner sentencePad=0.55, commaPad=0.22 (also no-clause-pad=0).
for (const [index, row] of golden.rows.entries()) {
  test(`plan piece lists retain master behavior ${index}`, () => {
    for (const entry of row.utterances) {
      const options: NarrationPacingConfig = { ...entry.options, pause_strategy: entry.options.pause_strategy === "none" ? "none" : undefined };
      expect(toPlannedUtterances(utterancesV1(row.text, options))).toEqual(entry.output);
      expect(planNarrationUtterances(row.text, options)).toEqual(entry.output);
    }
    for (const entry of row.breathing) {
      expect(toBreathingPieces(breathingV1(row.text, entry.sentencePad, entry.commaPad))).toEqual(entry.output);
      expect(splitForBreathing(row.text, entry.sentencePad, entry.commaPad)).toEqual(entry.output);
      expect(binBreathing(row.text, entry.sentencePad, entry.commaPad)).toEqual(entry.output);
    }
  });
}

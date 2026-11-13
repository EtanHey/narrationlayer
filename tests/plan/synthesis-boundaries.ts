import { splitForBreathing } from "../../src/plan/breathing.js";
import { planSynthesisUnits } from "../../src/plan/synthesis-units.js";
import { plannerFixtures } from "./synthesis-fixtures.js";

/** Characterization only: offsets refer to the same synthetic source string. */
export function characterizeBoundaries() {
  return plannerFixtures.map(fixture => {
    const text = fixture.units.map(unit => unit.text).join("\n");
    const boundaries = (parts: { text: string }[]) => {
      let cursor = 0;
      return parts.map(part => {
        const start = text.indexOf(part.text, cursor);
        if (start < 0) throw new Error("fixture output no longer matches source text");
        cursor = start + part.text.length;
        return cursor;
      });
    };
    const planner = boundaries(planSynthesisUnits(fixture).flatMap(piece => piece.segments));
    const runner = boundaries(splitForBreathing(text, 0.55, 0.25));
    return {
      name: fixture.name, max_chars: fixture.max_chars, planner, runner,
      planner_only: planner.filter(end => !runner.includes(end)),
      runner_only: runner.filter(end => !planner.includes(end)),
    };
  });
}

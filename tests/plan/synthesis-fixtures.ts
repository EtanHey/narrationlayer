import type { SynthesisSourceUnit } from "../../src/plan/synthesis-units.js";

const unit = (kind: SynthesisSourceUnit["kind"], text: string): SynthesisSourceUnit =>
  ({ kind, text, pause_after_ms: 200 });

// Synthetic lengths only: these words do not reproduce any recorded speech.
function sized(length: number): string {
  const body = "soft green leaves grow beside quiet water ".repeat(10).slice(0, length - 1);
  return `${body.trimEnd().padEnd(length - 1, "x")}.`;
}

export const shapeFixture = {
  name: "PLAN-03-shapes", max_chars: 100,
  units: [
    unit("heading", "Garden notes"),
    unit("list_item", "Plant three seeds"),
    unit("list_item", "Water all the small seedlings each morning"),
    unit("list_item", "Keep the young plants beside the wide window throughout the cool afternoon"),
    unit("list_item", "Care label: water the roots and leave the leaves dry"),
    unit("list_item", "Use garden_check to count the green shoots"),
    unit("list_item", "Read the planting guide link for the next steps"),
    unit("list_item", "Visit https://example.invalid/garden for the planting guide"),
    unit("sentence", "The gardeners gathered by the gate: they carried their baskets, they walked beside the river; they planted the new seeds — and they returned to the greenhouse before the evening rain."),
  ],
};

export const lengthsFixture = {
  name: "PLAN-03-lengths", max_chars: 300,
  units: [
    unit("heading", "Gardens"),
    unit("list_item", sized(23)),
    unit("list_item", sized(39)),
    unit("list_item", sized(192)),
    unit("list_item", `${sized(143)} ${sized(120)}`),
  ],
};

export const plannerFixtures = [shapeFixture, lengthsFixture];

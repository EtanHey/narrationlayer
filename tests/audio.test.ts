import { expect, test } from "bun:test";

import { findTailCutoffSeconds } from "../src/audio.js";

test("tail cleanup cuts after a long near-end silence before generated noise blips", () => {
  const cutoff = findTailCutoffSeconds(
    [
      { start: 1.2, end: 1.28, duration: 0.08 },
      { start: 2.09, end: 3.65, duration: 1.56 },
      { start: 3.88, end: 4.04, duration: 0.16 },
    ],
    4.4,
    {
      minSilenceSeconds: 0.35,
      tailWindowSeconds: 1,
      paddingSeconds: 0.12,
    },
  );

  expect(cutoff).toBe(2.21);
});

test("tail cleanup does not cut an internal pause with substantial audio after it", () => {
  const cutoff = findTailCutoffSeconds(
    [{ start: 2, end: 2.8, duration: 0.8 }],
    7,
    {
      minSilenceSeconds: 0.35,
      tailWindowSeconds: 1,
      paddingSeconds: 0.12,
    },
  );

  expect(cutoff).toBeUndefined();
});

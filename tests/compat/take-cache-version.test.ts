import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_TTS_RENDER_VERSION, computeContentHashKey } from "../../src/pipelines/local-tts/take-cache.js";

// The runner freezes an accepted take under computeContentHashKey. The key covers the
// spoken text, the reference, the profile and six parameters, but not the code that turns
// them into audio. This test makes an audible change to that code raise
// LOCAL_TTS_RENDER_VERSION: it fingerprints, per golden case, what the frozen goldens say
// the runner does for that case, and compares with the row recorded for the current version.

const fixtures = path.join(import.meta.dir, "fixtures");
const TABLE = "tests/compat/fixtures/take-cache-render-versions.json";
const CONSTANT = "LOCAL_TTS_RENDER_VERSION in src/pipelines/local-tts/take-cache.ts";
const read = (name: string) => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));

type Call = { tool: string; args: string[]; concat?: string };
type Row = { version: number; reason: string; previous?: string; cases: Record<string, string> };

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const rowDigest = (row: Row) => sha(stable(row));

// File names are not audible, their roles are: each fixture path becomes f0, f1, ... in
// order of first appearance within one run, so a rename keeps the fingerprint and a
// reordered or extra input (a concat list, a stage) changes it.
function symbolize(calls: Call[]) {
  const names = new Map<string, string>();
  const swap = (text: string) => text.replace(/\$FIXTURE\/[^\s']+/g, p => {
    if (!names.has(p)) names.set(p, `f${names.size}`);
    return names.get(p)!;
  });
  return calls.map(call => ({ tool: call.tool, args: call.args.map(swap), ...(call.concat === undefined ? {} : { concat: swap(call.concat) }) }));
}

/**
 * One fingerprint per golden case, over what decides the audio and nothing else:
 * - runner.golden.json, per run: the daemon request bodies in order, the breathing pieces
 *   and pads, and the ffmpeg argument lists in order (paths symbolized). Not headers,
 *   URLs, stderr, exit codes, the receipt or the probed format.
 * - plan-pieces.golden.json, per row: the breathing rows (pads in, pieces and pads out).
 *   The utterance rows belong to the job path, not the runner.
 * The ffmpeg log is one list for all runs; a run starts at the full-take conversion,
 * the only call that reads `out.wav.raw` (cache hits make no calls).
 */
function computeCases(): Record<string, string> {
  const runner = read("runner.golden.json") as { results: { referenceKind: string; spoken: string; requests: { body: unknown }[]; pieces: unknown }[]; argv: Call[] };
  const plan = read("plan-pieces.golden.json") as { rows: { text: string; breathing: unknown }[] };
  const runs: Call[][] = [];
  for (const call of runner.argv) {
    const input = call.args[call.args.indexOf("-i") + 1];
    if (input === "$FIXTURE/out.wav.raw") runs.push([]);
    if (!runs.length) throw new Error("take-cache version test: the first ffmpeg call is not the full-take conversion of out.wav.raw; update the run split in computeCases");
    runs.at(-1)!.push(call);
  }
  if (runs.length !== runner.results.length)
    throw new Error(`take-cache version test: ${runs.length} ffmpeg runs for ${runner.results.length} runner cases; update the run split in computeCases`);
  const cases: Record<string, string> = {};
  const add = (id: string, value: unknown) => {
    if (id in cases) throw new Error(`take-cache version test: duplicate case id ${id}`);
    cases[id] = sha(stable(value));
  };
  runner.results.forEach((result, i) => add(`runner/${result.referenceKind}/${sha(result.spoken).slice(0, 12)}`, {
    bodies: result.requests.map(request => request.body), pieces: result.pieces, ffmpeg: symbolize(runs[i]!),
  }));
  for (const row of plan.rows) add(`breathing/${sha(row.text).slice(0, 12)}`, row.breathing);
  return cases;
}

const rows = (read("take-cache-render-versions.json") as { rows: Row[] }).rows;
const rowToAppend = (version: number) => JSON.stringify({
  version, reason: "<what a listener hears differently, in words a consumer can read>",
  previous: rows.length ? rowDigest(rows.at(-1)!) : undefined, cases: computeCases(),
}, null, 2);

test("render version table: contiguous from 1, chained, and has a row for the constant", () => {
  const errors: string[] = [];
  rows.forEach((row, i) => {
    if (row.version !== i + 1) errors.push(`row ${i} has version ${row.version}; versions start at 1 and rise by exactly 1, and no row is ever removed`);
    if (typeof row.reason !== "string" || !row.reason.trim()) errors.push(`version ${row.version} has no reason`);
    if (!row.cases || typeof row.cases !== "object" || !Object.keys(row.cases).length) errors.push(`version ${row.version} has no cases`);
    const expected = i === 0 ? undefined : rowDigest(rows[i - 1]!);
    if (row.previous !== expected) errors.push(i === 0
      ? `version ${row.version} is the first row and carries no "previous"`
      : `version ${row.version}'s "previous" does not match version ${rows[i - 1]!.version}: an older row was edited. Rows for older versions are frozen; restore it.`);
  });
  const last = rows.at(-1)?.version ?? 0;
  if (last < LOCAL_TTS_RENDER_VERSION)
    errors.push(`${CONSTANT} is ${LOCAL_TTS_RENDER_VERSION} but ${TABLE} has no row for it. Append:\n${rowToAppend(LOCAL_TTS_RENDER_VERSION)}`);
  if (last > LOCAL_TTS_RENDER_VERSION)
    errors.push(`${TABLE} has a row for version ${last} but ${CONSTANT} is ${LOCAL_TTS_RENDER_VERSION}: raise the constant or drop the unreleased row`);
  if (errors.length) throw new Error(errors.join("\n"));
});

test("render version: the runner's audible behaviour matches the row recorded for the current version", () => {
  const row = rows.find(r => r.version === LOCAL_TTS_RENDER_VERSION);
  if (!row) throw new Error(`${TABLE} has no row for version ${LOCAL_TTS_RENDER_VERSION}; see the table test`);
  const now = computeCases();
  const changed = Object.keys(row.cases).filter(id => now[id] !== row.cases[id]);
  const added = Object.keys(now).filter(id => !(id in row.cases));
  if (changed.length) throw new Error([
    `The runner's audible behaviour changed for ${changed.length} golden case(s) since render version ${row.version} was recorded:`,
    ...changed.map(id => `  - ${id}${id in now ? "" : " (gone: its spoken text or input changed, or the case was removed)"}`),
    "The goldens freeze what the runner sends the daemon, how it cuts the text into breathing pieces and pads, and the",
    "ffmpeg calls it makes. They moved, so for an unchanged cache key the runner would now make different audio, while",
    "every consumer with a cache filled by the old code keeps replaying the old take.",
    `Fix: raise ${CONSTANT} to ${row.version + 1} and append this row to ${TABLE}, with the reason filled in:`,
    rowToAppend(row.version + 1),
    "Raising the version makes every consumer's cached take miss once, on purpose. If nothing audible changed, the goldens",
    "should not have moved: fix the change instead.",
  ].join("\n"));
  if (added.length) throw new Error([
    `${added.length} golden case(s) are not recorded for render version ${row.version}. A new case is not a change: add these`,
    `entries to the "cases" of the version ${row.version} row in ${TABLE} (no version raise needed):`,
    ...added.map(id => `  ${JSON.stringify(id)}: ${JSON.stringify(now[id])},`),
  ].join("\n"));
});

// Fixed synthetic input. The version-1 hex was computed on origin/master 5a100adf (before
// the render version existed): every key a consumer cached then must still hit.
const PIN_INPUT = {
  spokenText: "Synthetic render version pin, one. Two.", referenceClip: "/synthetic/reference.wav", referenceText: "Synthetic reference.",
  profileId: "synthetic-voice", profileVersion: "synthetic-v1", model: "synthetic-model",
  params: { eqHighshelfHz: 4000, eqHighshelfGainDb: 1.5, loudnessTargetDb: -20, atempo: 1.05, sentencePauseSeconds: 0.55, commaPauseSeconds: 0.22 },
};
const PIN_V1 = "128e293da872b2b5fabb6502fddd1c9f0a885bd049dca0e7e5e12066eafcd9ec";
const PIN_MINIMAL = { spokenText: "Hello", referenceClip: "/synthetic/reference.wav", referenceText: "Synthetic reference.", params: {} };
const PIN_MINIMAL_V1 = "bc769d5b4f60d6fd587c94bfa080890bc19b04fad884a5a2e78e89abbef3250e";

test("render version 1 keeps the pre-version key byte for byte; any other version changes it", () => {
  expect(computeContentHashKey({ ...PIN_INPUT, renderVersion: 1 })).toBe(PIN_V1);
  expect(computeContentHashKey({ ...PIN_MINIMAL, renderVersion: 1 })).toBe(PIN_MINIMAL_V1);
  const current = computeContentHashKey(PIN_INPUT);
  if (LOCAL_TTS_RENDER_VERSION === 1) expect(current).toBe(PIN_V1);
  else expect(current).not.toBe(PIN_V1);
  const v2 = computeContentHashKey({ ...PIN_INPUT, renderVersion: 2 });
  expect(v2).toMatch(/^[a-f0-9]{64}$/);
  expect(v2).not.toBe(PIN_V1);
  expect(computeContentHashKey({ ...PIN_INPUT, renderVersion: 3 })).not.toBe(v2);
  for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => computeContentHashKey({ ...PIN_INPUT, renderVersion: bad })).toThrow("invalid render version");
});

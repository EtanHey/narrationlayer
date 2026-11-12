import { test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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

// Written in three places with the same words: here (printed with every failure), the
// table's "contract" field and docs/architecture.md. The test checks all three agree.
const CONTRACT = "An existing entry of a recorded row changes in only three ways, each named by this test: a version raise appends a new row; a change to a case's cache-key inputs (its spoken text, reference, profile or parameters) replaces the entries the test prints; and when the audio for an unchanged key did not change, an attested re-record rewrites the entries the test prints and adds a line with its reason to the row's rerecorded list. Anything else, and any change to the projection or the run split in tests/compat/take-cache-version.test.ts, is a review stop.";
// Every failure this test throws ends with the contract.
const failure = (lines: string[]) => new Error([...lines, CONTRACT].join("\n"));

type Call = { tool: string; args: string[]; concat?: string };
type Rerecord = { cases: string[] | "all"; reason: string };
type Row = { version: number; reason: string; previous?: string; cases: Record<string, string>; rerecorded?: Rerecord[] };
type RunnerResult = { referenceKind: string; keyPreimage: Record<string, unknown>; requests: { body: unknown }[]; pieces: unknown };

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const rowDigest = (row: Row) => sha(stable(row));

// Inputs an ffmpeg call reads: each `-i` value, except a generated `-f lavfi` source; for
// a `-f concat` list, the files the list names. Its output is the last argument unless "-".
function inputsOf(call: Call): string[] {
  const inputs: string[] = [];
  let format: string | undefined;
  call.args.forEach((arg, i) => {
    if (arg === "-f") format = call.args[i + 1];
    if (arg !== "-i") return;
    if (format === "concat") inputs.push(...[...(call.concat ?? "").matchAll(/^file '(.*)'$/gm)].map(m => m[1]!));
    else if (format !== "lavfi") inputs.push(call.args[i + 1]!);
    format = undefined;
  });
  return inputs;
}
const outputOf = (call: Call) => (call.args.at(-1) === "-" ? undefined : call.args.at(-1));

/**
 * Split the golden's single ffmpeg log into one run per runner case, from structure and
 * from what the harness fixes, never from a file name: cache hits make no calls, and a
 * fresh run reads exactly one file per daemon request that no earlier call of the run
 * wrote. A run ends when it has read all of them and the next call reads a new one.
 */
function splitRuns(results: RunnerResult[], calls: Call[]): Call[][] {
  const fail = (detail: string) => failure([
    `take-cache version test: could not split the ffmpeg log into one run per runner case (${detail}).`,
    "This is a problem with the test's split, not an audible change: update splitRuns in tests/compat/take-cache-version.test.ts",
    "(a change to the projection, so a review stop) and do NOT raise the render version for this message. Once the split works,",
    "the test says whether a raise is needed.",
  ]);
  const runs: Call[][] = [];
  let next = 0;
  for (const [index, result] of results.entries()) {
    const run: Call[] = [], written = new Set<string>();
    let read = 0;
    while (next < calls.length) {
      const call = calls[next]!;
      const fresh = inputsOf(call).filter(input => !written.has(input)).length;
      if (run.length && read >= result.requests.length && fresh) break;
      read += fresh; run.push(call); next += 1;
      const output = outputOf(call);
      if (output) written.add(output);
    }
    if (read !== result.requests.length) throw fail(`case ${index} read ${read} daemon outputs for ${result.requests.length} requests`);
    runs.push(run);
  }
  if (next !== calls.length) throw fail(`${calls.length - next} calls left after ${results.length} runs`);
  return runs;
}

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

// Every runner golden that records a cache key or key preimage, with the test file that writes it.
// computeCases reads exactly these files, and a version raise regenerates exactly these files.
const KEYED_RUNNER_GOLDENS = [
  { name: "runner", writtenBy: "tests/compat/runner-executable.test.ts" },
  { name: "runner-defaults-sentence-only", writtenBy: "tests/compat/runner-defaults.test.ts" },
  { name: "runner-defaults-comma-only", writtenBy: "tests/compat/runner-defaults.test.ts" },
  { name: "runner-defaults-no-tempo", writtenBy: "tests/compat/runner-defaults.test.ts" },
];

/**
 * One fingerprint per golden case, over what decides the audio for an unchanged cache key:
 * - each file in KEYED_RUNNER_GOLDENS, per run: request bodies, breathing pieces
 *   and pads, and the ffmpeg argument lists in order (paths symbolized). Not headers, URLs,
 *   stderr, exit codes, the receipt or the probed format. The case id is a hash of the
 *   run's cache-key preimage without the render version, so a change to what the key
 *   already covers (spoken text, reference clip and text, profile, model, parameters) gives
 *   a new id, never a changed fingerprint for an old id.
 * - plan-pieces.golden.json, per row: the breathing rows (pads in, pieces and pads out),
 *   keyed by the row's text, which goes into the cutter as is, without normalization.
 *   The utterance rows belong to the job path, not the runner.
 */
function computeCases(): Record<string, string> {
  const plan = read("plan-pieces.golden.json") as { rows: { text: string; breathing: unknown }[] };
  const cases: Record<string, string> = {};
  const add = (id: string, value: unknown) => {
    if (id in cases) throw failure([`take-cache version test: duplicate case id ${id}`]);
    cases[id] = sha(stable(value));
  };
  for (const { name } of KEYED_RUNNER_GOLDENS) {
    const runner = read(`${name}.golden.json`) as { results: RunnerResult[]; argv: Call[] };
    const runs = splitRuns(runner.results, runner.argv);
    runner.results.forEach((result, i) => {
      const { renderVersion: _version, ...key } = result.keyPreimage;
      // The defaults fixtures are named-profile runs; they omit referenceKind.
      const referenceKind = name === "runner" ? result.referenceKind : "profile";
      add(`runner/${referenceKind}/${sha(stable(key)).slice(0, 12)}`, {
        bodies: result.requests.map(request => request.body), pieces: result.pieces, ffmpeg: symbolize(runs[i]!),
      });
    });
  }
  for (const row of plan.rows) add(`breathing/${sha(row.text).slice(0, 12)}`, row.breathing);
  return cases;
}

const table = read("take-cache-render-versions.json") as { contract: string; rows: Row[] };
const rows = table.rows;
const raiseSteps = (version: number) => [
  `Fix: a raise sets the constant, regenerates every runner golden that records a cache key or key preimage, and appends a row:`,
  `  1. src/pipelines/local-tts/take-cache.ts: set LOCAL_TTS_RENDER_VERSION to ${version}.`,
  `  2. Every runner golden that records a cache key or key preimage (the runner goldens this test reads) now carries the version:`,
  ...KEYED_RUNNER_GOLDENS.map(({ name }) => `       tests/compat/fixtures/${name}.golden.json`),
  `     Regenerate them with`,
  `       UPDATE_COMPAT_GOLDENS=1 bun test ${[...new Set(KEYED_RUNNER_GOLDENS.map(g => g.writtenBy))].join(" ")}`,
  `     (it exits 1 after writing), then run the same command again without the variable.`,
  `     This is the raise's own regeneration; it comes after the behaviour regeneration in tests/compat/README.md, so each`,
  `     regenerated file may differ from the one before it only in key material (the renderVersion in each keyPreimage and each`,
  `     receipt cacheKey). Any other diff, in these files or`,
  `     in any other golden the command rewrites, is a review stop.`,
  `  3. ${TABLE}: append this row, with the reason filled in:`,
  JSON.stringify({
    version, reason: "<what a listener hears differently, in words a consumer can read>",
    previous: rows.length ? rowDigest(rows.at(-1)!) : undefined, cases: computeCases(),
  }, null, 2),
  "Raising the version makes every consumer's cached take miss once, on purpose.",
].join("\n");
const entries = (ids: string[], from: Record<string, string>) => ids.map(id => `  ${JSON.stringify(id)}: ${JSON.stringify(from[id])},`);
const kind = (id: string) => id.split("/").slice(0, 2).join("/");

test("render version table: contiguous from 1, chained, and has a row for the constant", () => {
  const errors: string[] = [];
  rows.forEach((row, i) => {
    if (row.version !== i + 1) errors.push(`row ${i} has version ${row.version}; versions start at 1 and rise by exactly 1, and no row is ever removed`);
    if (typeof row.reason !== "string" || !row.reason.trim()) errors.push(`version ${row.version} has no reason`);
    if (!row.cases || typeof row.cases !== "object" || !Object.keys(row.cases).length) errors.push(`version ${row.version} has no cases`);
    for (const [j, item] of (row.rerecorded ?? []).entries()) {
      if (typeof item?.reason !== "string" || !item.reason.trim()) errors.push(`version ${row.version} rerecorded[${j}] has no reason: say why the audio is the same, and how that was shown`);
      const ids = item?.cases;
      if (ids !== "all" && (!Array.isArray(ids) || !ids.length)) errors.push(`version ${row.version} rerecorded[${j}] names no cases: list case ids or "all"`);
      else if (Array.isArray(ids)) for (const id of ids) if (!Object.hasOwn(row.cases ?? {}, id)) errors.push(`version ${row.version} rerecorded[${j}] names ${id}, which is not a case of that row`);
    }
    const expected = i === 0 ? undefined : rowDigest(rows[i - 1]!);
    if (row.previous !== expected) errors.push(i === 0
      ? `version ${row.version} is the first row and carries no "previous"`
      : `version ${row.version}'s "previous" does not match version ${rows[i - 1]!.version}: an older row was edited. Rows for older versions are frozen; restore it.`);
  });
  const last = rows.at(-1)?.version ?? 0;
  if (last < LOCAL_TTS_RENDER_VERSION) errors.push(`${CONSTANT} is ${LOCAL_TTS_RENDER_VERSION} but ${TABLE} has no row for it.\n${raiseSteps(LOCAL_TTS_RENDER_VERSION)}`);
  if (last > LOCAL_TTS_RENDER_VERSION)
    errors.push(`${TABLE} has a row for version ${last} but ${CONSTANT} is ${LOCAL_TTS_RENDER_VERSION}: raise the constant or drop the unreleased row`);
  if (errors.length) throw failure(errors);
});

test("render version: the test reads every runner golden that records a cache key or key preimage", () => {
  const keyed = readdirSync(fixtures).filter(file => file.endsWith(".golden.json") && /"(keyPreimage|cacheKey)"/.test(readFileSync(path.join(fixtures, file), "utf8")));
  const listed = KEYED_RUNNER_GOLDENS.map(({ name }) => `${name}.golden.json`);
  const missing = keyed.filter(file => !listed.includes(file)), extra = listed.filter(file => !keyed.includes(file));
  if (missing.length || extra.length) throw failure([
    "KEYED_RUNNER_GOLDENS in tests/compat/take-cache-version.test.ts must list exactly the goldens that record a cache key or key preimage",
    ...missing.map(file => `  - missing: ${file}`), ...extra.map(file => `  - records no key: ${file}`),
  ]);
});

test("render version contract: the table and docs/architecture.md carry the test's wording", () => {
  if (table.contract !== CONTRACT) throw failure([`the "contract" field of ${TABLE} must equal the test's wording word for word:`]);
  const docs = readFileSync(path.join(import.meta.dir, "../../docs/architecture.md"), "utf8").replace(/\s+/g, " ");
  if (!docs.includes(CONTRACT)) throw failure(["docs/architecture.md must carry the render-version contract word for word:"]);
});

test("render version: the runner's audible behaviour matches the row recorded for the current version", () => {
  const row = rows.find(r => r.version === LOCAL_TTS_RENDER_VERSION);
  if (!row) throw failure([`${TABLE} has no row for version ${LOCAL_TTS_RENDER_VERSION}; see the table test`]);
  const now = computeCases();
  const changed = Object.keys(row.cases).filter(id => id in now && now[id] !== row.cases[id]);
  const gone = Object.keys(row.cases).filter(id => !(id in now));
  const added = Object.keys(now).filter(id => !(id in row.cases));
  if (changed.length) throw failure([
    `What the runner does changed for ${changed.length} golden case(s) whose cache key is the same as at render version ${row.version}:`,
    ...changed.map(id => `  - ${id}`),
    "The goldens freeze what the runner sends the daemon, how it cuts the text into breathing pieces and pads, and the ffmpeg",
    "calls it makes. This test cannot tell whether the change is audible; you decide, and exactly one of these two follows:",
    "",
    "OUTCOME 1. The audio for an unchanged key changed (cutting, pauses, the processing chain, what is sent to the engine).",
    "Raise the version: every consumer with a cache filled by the old code would otherwise keep replaying the old take.",
    raiseSteps(row.version + 1),
    "",
    "OUTCOME 2. The audio for an unchanged key did not change (only the order of independent steps, a temporary or",
    "preparatory step, a renamed role). Do NOT raise. In the version " + row.version + ` row of ${TABLE}, set these entries:`,
    ...entries(changed, now),
    `and add one line to that row's "rerecorded" list (create the list if it is missing):`,
    `  ${JSON.stringify({ cases: changed, reason: "<why the audio is the same, and how that was shown>" })}`,
    "The test checks only that the reason is there and the ids exist; whether it is true is the review stop.",
    "",
  ]);
  // A recorded runner case whose id is gone, with a new case of the same kind in its place,
  // had its cache-key inputs changed: its key changed by itself and no old take is replayed.
  const replaced = gone.filter(id => id.startsWith("runner/") && gone.filter(g => kind(g) === kind(id)).length <= added.filter(a => kind(a) === kind(id)).length);
  const removed = gone.filter(id => !replaced.includes(id));
  if (removed.length) throw failure([
    `${removed.length} case(s) recorded for render version ${row.version} are no longer in the goldens, with nothing in their place:`,
    ...removed.map(id => `  - ${id}`),
    "A golden case was removed or its input edited (the goldens are frozen, so this needs a reason). Deleting the entries",
    "is a review stop.",
  ]);
  if (replaced.length) throw failure([
    `The cache-key inputs of ${replaced.length} runner case(s) changed (their spoken text, reference, profile or parameters):`,
    "the key already covers these, so the changed cases get new keys by themselves and no consumer replays an old take.",
    "This is not a version raise. Fix: in the version " + row.version + ` row of ${TABLE}, REPLACE these entries`,
    ...entries(replaced, row.cases).map(line => line.replace(/^ {2}/, "  - remove ")),
    "with these:",
    ...entries(added, now).map(line => line.replace(/^ {2}/, "  + add ")),
    "If the cutting, the pauses or the ffmpeg chain changed in the same edit, the cases whose key did not change (and the",
    "breathing rows) ask for the raise only if they exercise that change. None did, or this message would not show, so if",
    "that change is audible, raise the version anyway. The test matches cases by kind and count only, not by descent: a removed case",
    "plus an unrelated new one looks the same, so a reviewer must look at what was removed.",
  ]);
  if (added.length) throw failure([
    `${added.length} golden case(s) are not recorded for render version ${row.version}. A new case alone needs no raise: add these`,
    `entries to the "cases" of the version ${row.version} row in ${TABLE}:`,
    ...entries(added, now),
    "",
    "But if you added it to show a change you made to the runner's cutting, pauses or ffmpeg chain, that change is audible",
    "for texts already cached: raise the version, even though no recorded case moved. This test sees only what the recorded",
    "cases exercise. Instead of the entries above:",
    raiseSteps(row.version + 1),
  ]);
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
  const check = (ok: boolean, what: string, expected: string, received: string) => {
    if (!ok) throw failure([`take-cache key pin: ${what}. Expected ${expected}, received ${received}.`, "Version-1 keys must stay byte for byte the keys from before the render version existed; do not edit the pins."]);
  };
  const pinned = computeContentHashKey({ ...PIN_INPUT, renderVersion: 1 });
  check(pinned === PIN_V1, "PIN_V1 (full synthetic input at version 1) changed", PIN_V1, pinned);
  const minimal = computeContentHashKey({ ...PIN_MINIMAL, renderVersion: 1 });
  check(minimal === PIN_MINIMAL_V1, "PIN_MINIMAL_V1 (minimal synthetic input at version 1) changed", PIN_MINIMAL_V1, minimal);
  const current = computeContentHashKey(PIN_INPUT);
  check((current === PIN_V1) === (LOCAL_TTS_RENDER_VERSION === 1), `the default key at version ${LOCAL_TTS_RENDER_VERSION} must ${LOCAL_TTS_RENDER_VERSION === 1 ? "equal" : "differ from"} PIN_V1`, LOCAL_TTS_RENDER_VERSION === 1 ? PIN_V1 : `not ${PIN_V1}`, current);
  const v2 = computeContentHashKey({ ...PIN_INPUT, renderVersion: 2 });
  check(/^[a-f0-9]{64}$/.test(v2) && v2 !== PIN_V1, "the version-2 key must be a sha256 hex different from PIN_V1", `64 hex, not ${PIN_V1}`, v2);
  const v3 = computeContentHashKey({ ...PIN_INPUT, renderVersion: 3 });
  check(v3 !== v2, "versions 2 and 3 must give different keys", `not ${v2}`, v3);
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    let message = "no error";
    try { computeContentHashKey({ ...PIN_INPUT, renderVersion: bad }); } catch (error) { message = (error as Error).message; }
    check(message.includes("invalid render version"), `renderVersion ${bad} must throw "invalid render version"`, "that error", message);
  }
});

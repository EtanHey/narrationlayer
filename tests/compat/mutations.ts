// Run serially: bun tests/compat/mutations.ts (mutates and restores source files).
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, rmSync } from "node:fs";
import { Window } from "happy-dom";
import { createHash } from "node:crypto";
import path from "node:path";
import { repo, tool } from "./harness.js";
type Anchor = { name: string; file: string; before: string; after: string };
export type MutationRow = Anchor & (
  | { kind: "compat-pattern"; pattern: string }
  // Full path joins describe scopes and test name with spaces: "outer inner test name".
  | { kind: "named-test"; testFile: string; testName: string }
  | { kind: "conformance-case"; binding: string; caseId: string }
);
export const cases: MutationRow[] = [
  {"kind": "named-test", "name": "session-plan-first", "file": "src/engine/session/session.ts", "before": "for (const effect of result.effects) {", "after": "for (const effect of result.effects.reverse()) {", "testFile": "tests/engine/session/session.test.ts", "testName": "PLAN-LAT-01: plan is enqueued before the first backend call"},
  {"kind": "named-test", "name": "session-piece-order", "file": "src/engine/session/session.ts", "before": "index = session.delivered.length;", "after": "index = session.plan.pieces.length - 1 - session.delivered.length;", "testFile": "tests/engine/session/session.test.ts", "testName": "ORDER-01 (lease clause owed to S7): ordered prefix and no events after outcome"},
  {"kind": "named-test", "name": "session-result-fence", "file": "src/engine/session/session.ts", "before": "abort.signal.throwIfAborted();", "after": "", "testFile": "tests/engine/session/session.test.ts", "testName": "late result after stop: fenced audio produces no event or publication"},
  {"kind": "named-test", "name": "reducer-duplicate-accept", "file": "src/engine/reducer/session.ts", "before": " || input.kind === \"accept\" && Object.hasOwn(engine.admissions, input.request.idempotency_key)", "after": "", "testFile": "tests/engine/reducer/session.test.ts", "testName": "ID-04: same key and same request replays the original accepted; a different request conflicts; a different key is a new session"},
  {"kind": "named-test", "name": "reducer-error-fields", "file": "src/engine/reducer/session.ts", "before": "type: \"error\", code, message, phase: \"synthesize\"", "after": "type: \"error\", ...input.result.error, phase: \"synthesize\"", "testFile": "tests/engine/reducer/session.test.ts", "testName": "ERR-01: a live failure emits error then outcome; a fenced or terminal one emits nothing"},

  {"kind": "named-test", "name": "reducer-ID04", "file": "src/engine/reducer/session.ts", "before": "key(engine.sessions[receipt.session_id].request) === key(input.request)", "after": "true", "testFile": "tests/engine/reducer/session.test.ts", "testName": "ID-04: same key and same request replays the original accepted; a different request conflicts; a different key is a new session"},
  {"kind": "named-test", "name": "reducer-ERR01", "file": "src/engine/reducer/session.ts", "before": "emit({ type: \"error\", code, message, phase: \"synthesize\", retry: \"new_request\", session_id }); ", "after": "", "testFile": "tests/engine/reducer/session.test.ts", "testName": "ERR-01: a live failure emits error then outcome; a fenced or terminal one emits nothing"},

  {"kind": "named-test", "name": "reducer-I01", "file": "src/engine/reducer/session.ts", "before": "if (s.playback !== null) return", "after": "if (false) return", "testFile": "tests/engine/reducer/session.test.ts", "testName": "I01: a player failure after the natural end keeps completed"},
  {"kind": "named-test", "name": "reducer-I02", "file": "src/engine/reducer/session.ts", "before": " && input.identity.attempt_id === s.attempt_id", "after": "", "testFile": "tests/engine/reducer/session.test.ts", "testName": "I02: matching feedback moves state; foreign job owner and attempt cannot"},
  {"kind": "named-test", "name": "reducer-I03", "file": "src/engine/reducer/session.ts", "before": "s.generation = \"cancelled\"; s.fenced = true;", "after": "s.generation = \"running\"; s.fenced = false;", "testFile": "tests/engine/reducer/session.test.ts", "testName": "I03: cancellation fences delivery and commit, including late backend results"},
  {"kind": "named-test", "name": "reducer-I04", "file": "src/engine/reducer/session.ts", "before": "s.started && s.delivered.length === s.plan.pieces.length && f.piece_index", "after": "s.started && f.piece_index", "testFile": "tests/engine/reducer/session.test.ts", "testName": "I04: natural EOF needs actual start and N-piece coverage; no seek"},
  {"kind": "named-test", "name": "reducer-A1-previous-job", "file": "src/engine/reducer/session.ts", "before": "if (next) s.previous = !moved ? { player_instance_id: s.current.player_instance_id, piece_index: s.current.piece_index } : null;", "after": "s.previous = null;", "testFile": "tests/engine/reducer/session.test.ts", "testName": "A1: previous player exits settle in both orders with distinct and reused ids"},

  {"kind":"compat-pattern","name":"job-daemon-timeout","file":"src/pipelines/job-render/index.ts","before":"timeoutMs: config.timeout_ms ?? 30_000","after":"timeoutMs: config.timeout_ms ?? 31_000","pattern":"job daemon observables"},
  {"kind":"compat-pattern","name":"runner-daemon-timeout","file":"bin/local-tts-runner.ts","before":"timeoutMs: 120_000","after":"timeoutMs: 121_000","pattern":"runner daemon observables"},
  {"kind":"compat-pattern","name":"job-daemon-slash","file":"src/pipelines/job-render/index.ts","before":".replace(/\\/+$/, \"\")","after":"","pattern":"job daemon observables"},
  {"kind":"compat-pattern","name":"runner-daemon-slash","file":"src/pipelines/local-tts/synthesis.ts","before":".replace(/\\/+$/, \"\")","after":"","pattern":"runner daemon observables"},
  {"kind":"compat-pattern","name":"job-silence-pad","file":"src/audio.ts","before":"String(chunk.pauseAfterSeconds)","after":"String(chunk.pauseAfterSeconds * 2)","pattern":"job service"},
  {"kind":"compat-pattern","name":"job-silence-rate","file":"src/audio.ts","before":"anullsrc=channel_layout=mono:sample_rate=24000","after":"anullsrc=channel_layout=mono:sample_rate=22050","pattern":"job service"},
  {"kind":"compat-pattern","name":"runner-newlines","file":"src/pipelines/local-tts/index.ts","before":"      spokenText,\n      sentencePad,","after":"      spokenText: spokenText.replace(/\\n/g, \" \"),\n      sentencePad,","pattern":"runner executable goldens"},
  {"kind":"compat-pattern","name":"job-pause","file":"src/plan/utterances.ts","before":"DEFAULT_SENTENCE_PAUSE_SECONDS = 0.55","after":"DEFAULT_SENTENCE_PAUSE_SECONDS = 0.56","pattern":"job service manifest"},
  {"kind":"compat-pattern","name":"runner-pause","file":"src/pipelines/local-tts/index.ts","before":"resolved.sentencePauseSeconds ?? 0.55","after":"resolved.sentencePauseSeconds ?? 0.56","pattern":"runner executable goldens"},
  {"kind":"compat-pattern","name":"runner-auth","file":"src/backends/qwen3-daemon.ts","before":"Authorization: `Bearer ${args.authToken}`","after":"\"X-Dropped-Authorization\": `Bearer ${args.authToken}`","pattern":"runner executable"},
  {"kind":"compat-pattern","name":"job-auth","file":"src/backends/qwen3-daemon.ts","before":"Authorization: `Bearer ${args.authToken}`","after":"\"X-Dropped-Authorization\": `Bearer ${args.authToken}`","pattern":"job service"},
  {"kind":"compat-pattern","name":"profile-base","file":"bin/local-tts-runner.ts","before":"findProfile(ref, path.resolve(import.meta.dir, \"..\"))","after":"findProfile(ref, path.resolve(import.meta.dir, \"../..\"))","pattern":"runner entry root lookup without profile-file environment"},
  {"kind":"compat-pattern","name":"failure-cleanup","file":"src/pipelines/local-tts/breathing.ts","before":"await unlink(p);","after":"/* scratch: leave intermediate output behind */","pattern":"runner removes intermediate output"},
  {"kind":"compat-pattern","name":"spoken-form","file":"src/text-normalize.ts","before":"`pull request ${referenceNumber(n)}`","after":"`changed request ${referenceNumber(n)}`","pattern":"runner executable goldens"},
  {"kind":"compat-pattern","name":"silent-http","file":"src/pipelines/job-render/synthesis.ts","before":"throw new Error(`voicelayer-qwen3 synthesize failed (${failure.status}): ${failure.body || failure.statusText}`);","after":"return {};","pattern":"job service thrown error golden: http"},
  {"kind":"compat-pattern","name":"job-probe-default","file":"src/pipelines/job-render/index.ts","before":"normalizeDuration(await (config.audio_duration_probe ?? probeAudioDurationSeconds)(audioPath))","after":"normalizeDuration(await (config.audio_duration_probe ?? (async () => undefined))(audioPath))","pattern":"job service probes unauthored"},
  {"kind":"compat-pattern","name":"job-probe-scale-1.05","file":"src/audio.ts","before":"return Number(value.toFixed(3));","after":"return Number((value * 1.05).toFixed(3));","pattern":"job service probes unauthored"},
  {"kind":"compat-pattern","name":"job-probe-scale-0.9","file":"src/audio.ts","before":"return Number(value.toFixed(3));","after":"return Number((value * 0.9).toFixed(3));","pattern":"job service probes unauthored"},
  {"kind":"compat-pattern","name":"job-probe-scale-1.5","file":"src/audio.ts","before":"return Number(value.toFixed(3));","after":"return Number((value * 1.5).toFixed(3));","pattern":"job service probes unauthored"},
  {"kind":"compat-pattern","name":"runner-loudness-result","file":"src/pipelines/local-tts/loudness.ts","before":"\n  await rename(tmpPath, output);","after":"\n  await (await import(\"node:fs/promises\")).unlink(tmpPath);","pattern":"runner executable goldens"},
  {"kind":"compat-pattern","name":"runner-hit-sidecar","file":"src/pipelines/local-tts/index.ts","before":"    await writeFile(`${output}.spoken.txt`, spokenText, \"utf8\");","after":"/* scratch: omit HIT spoken sidecar */","pattern":"runner executable goldens"},
  {"kind":"compat-pattern","name":"job-secret-fallback","file":"src/pipelines/job-render/config.ts","before":"    process.env.VOICELAYER_TTS_DAEMON_SECRET_FILE ||\n","after":"","pattern":"job service daemon auth"},
  {"kind":"compat-pattern","name":"job-env-daemon_url","file":"src/service.ts","before":"process.env.NARRATIONLAYER_QWEN3_DAEMON_URL ?? overrides.daemon_url","after":"overrides.daemon_url ?? process.env.NARRATIONLAYER_QWEN3_DAEMON_URL","pattern":"job service daemon auth"},
  {"kind":"compat-pattern","name":"job-env-auth_token","file":"src/service.ts","before":"process.env.NARRATIONLAYER_QWEN3_AUTH_TOKEN ?? overrides.auth_token","after":"overrides.auth_token ?? process.env.NARRATIONLAYER_QWEN3_AUTH_TOKEN","pattern":"job service daemon auth"},
  {"kind":"compat-pattern","name":"job-env-auth_token_file","file":"src/service.ts","before":"process.env.NARRATIONLAYER_QWEN3_AUTH_TOKEN_FILE ?? overrides.auth_token_file","after":"overrides.auth_token_file ?? process.env.NARRATIONLAYER_QWEN3_AUTH_TOKEN_FILE","pattern":"job service daemon auth"},
  {"kind":"compat-pattern","name":"stderr-abort-class","file":"tests/compat/harness.ts","before":"The operation was aborted\\.(?=\\r?$)","after":"[^\\n]*abort[^\\n]*","pattern":"stderr timeout classification"},
  {"kind":"compat-pattern","name":"job-assembly-dir","file":"src/audio.ts","before":"path.join(os.tmpdir(), \"narrationlayer-audio-\")","after":"path.join(path.dirname(outputPath), \"narrationlayer-audio-\")","pattern":"job service manifest"},
  {"kind":"compat-pattern","name":"runner-http-exit","file":"src/pipelines/local-tts/synthesis.ts","before":"throw new RunnerFailure(\n        `daemon /synthesize failed","after":"throw new Error(\n        `daemon /synthesize failed","pattern":"runner HTTP failure during breathing"},
  { kind: "named-test", name: "planner-minimum-words", file: "src/plan/synthesis-units.ts", before: "const MIN_SYNTHESIS_WORDS = 3;", after: "const MIN_SYNTHESIS_WORDS = 2;", testFile: "tests/plan/synthesis-units.test.ts", testName: "PLAN-D5: two-word remainder joins; a three-word remainder stands" },
  { kind: "named-test", name: "read-plan-partition", file: "src/plan/read-plan.ts", before: "word_start: start, word_end: cursor,", after: "word_start: start, word_end: cursor + 1,", testFile: "tests/plan/read-plan.test.ts", testName: "partition: every document word belongs to exactly one segment and piece" },
  { kind: "named-test", name: "read-plan-token-match", file: "src/plan/read-plan.ts", before: 'if (words[cursor]?.text !== token[0]) throw new ReadPlanError("TOKEN_MISMATCH");', after: '/* scratch: skip token comparison */', testFile: "tests/plan/read-plan.test.ts", testName: "token disagreement throws before a plan escapes" },
  { kind: "named-test", name: "read-plan-kind", file: "src/plan/read-plan.ts", before: 'segment.kind === "list_item" ? "item" : segment.kind', after: 'segment.kind', testFile: "tests/plan/read-plan.test.ts", testName: "every plan parses: the projected fixtures are wire events" },
  { kind: "named-test", name: "planner-word-boundary", file: "src/plan/synthesis-units.ts", before: "[,;:—―–-](?=\\s|$)", after: "[,;:―–-](?=\\s|$)|[—]", testFile: "tests/plan/synthesis-round1.test.ts", testName: "word boundary: every cut falls on whitespace" },
  // Clock deadline inclusivity is independent of the conformance command entry module.
  { kind: "conformance-case", name: "conformance-clock-deadline", file: "src/engine/conformance/clock.ts", before: "next[1].at > end", after: "next[1].at >= end", binding: "src/engine/conformance/null-binding.ts", caseId: "CONF-02" },
];
const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let runningChild: ReturnType<typeof Bun.spawn> | undefined;
let pending: { file: string; original: Buffer; reportDir: string | undefined } | undefined;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    try {
      runningChild?.kill("SIGTERM");
      if (pending) {
        writeFileSync(pending.file, pending.original);
        if (pending.reportDir) rmSync(pending.reportDir, { recursive: true, force: true });
      }
    } finally { process.exit(code); }
  });
}
type Run = { code: number; stdout: string; stderr: string; junit: string | undefined };
async function invoke(row: MutationRow, cwd: string, reportFile?: string): Promise<Run> {
  const args = row.kind === "compat-pattern" ? ["test", "tests/compat", "--test-name-pattern", row.pattern]
    : row.kind === "named-test" ? ["test", row.testFile, "--test-name-pattern", `^${literal(row.testName)}$`]
    : ["run", "conformance", "--binding", row.binding];
  if (reportFile) args.push("--reporter=junit", `--reporter-outfile=${reportFile}`);
  const child = Bun.spawn([tool("bun"), ...args], {
    cwd, env: { ...process.env, UPDATE_COMPAT_GOLDENS: "0", NO_COLOR: "1", FORCE_COLOR: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  runningChild = child;
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  runningChild = undefined;
  const junit = reportFile ? await readFile(reportFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }) : undefined;
  return { code, stdout, stderr, junit };
}
const xmlWindow = new Window();
function namedResult(row: Extract<MutationRow, { kind: "named-test" }>, run: Run) {
  if (!run.junit) return undefined;
  const document = new xmlWindow.DOMParser().parseFromString(run.junit, "application/xml");
  if (document.documentElement?.tagName !== "testsuites" || document.querySelector("parsererror"))
    throw new Error(`Invalid JUnit report: ${row.name}`);
  const matches = [...document.querySelectorAll("testcase")].filter(test => {
    const names = [test.getAttribute("name")];
    // The outermost testsuite is the file, not a describe scope.
    for (let parent = test.parentElement; parent?.parentElement?.tagName === "testsuite"; parent = parent.parentElement)
      names.unshift(parent.getAttribute("name"));
    return names.join(" ") === row.testName;
  });
  if (matches.length > 1) throw new Error(`Named test is ambiguous: ${matches.length} matches: ${row.testName}`);
  const test = matches[0];
  return !test ? undefined : test.querySelector("failure") ? "fail" : test.querySelector("skipped") ? "skipped" : "pass";
}
function caseResult(row: Extract<MutationRow, { kind: "conformance-case" }>, run: Run) {
  let parsed: unknown;
  try { parsed = JSON.parse(run.stdout); }
  catch { throw new Error(`Conformance report cannot be parsed: ${row.name}`); }
  if (!parsed || typeof parsed !== "object" || !("schema" in parsed) || parsed.schema !== "nl.conformance/1"
    || !("rows" in parsed) || !Array.isArray(parsed.rows)) throw new Error(`Invalid conformance report: ${row.name}`);
  const rows = parsed.rows.map((value: unknown) => {
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string"
      || !("result" in value) || !["pass", "fail", "inactive"].includes(String(value.result)))
      throw new Error(`Invalid conformance row: ${row.name}`);
    return { id: value.id, result: value.result };
  });
  const matches = rows.filter(result => result.id === row.caseId);
  if (matches.length !== 1) throw new Error(`Conformance case not found: ${row.caseId}`);
  return matches[0]?.result;
}
function verify(row: MutationRow, run: Run, restored: boolean) {
  if (row.kind === "compat-pattern") {
    if (restored ? run.code !== 0 : run.code === 0)
      throw new Error(`${restored ? "Restored test failed" : "Mutation survived"}: ${row.name}`);
  } else if (row.kind === "named-test") {
    const result = namedResult(row, run);
    if (restored) {
      if (!result) throw new Error(`Named test not found: ${row.testName}`);
      if (result === "skipped") throw new Error(`Mutation did not reach the named test: ${row.testName}`);
      if (result !== "pass" || run.code !== 0) throw new Error(`Restored named test failed: ${row.testName}`);
    } else {
      if (result === "pass") throw new Error(`Mutation survived: named test still green: ${row.testName}`);
      if (result !== "fail" || run.code === 0) throw new Error(`Mutation did not reach the named test: ${row.testName}`);
    }
  } else {
    const result = caseResult(row, run);
    if (result !== (restored ? "pass" : "fail") || (restored && run.code !== 0))
      throw new Error(`${restored ? "Restored case failed" : "Mutation survived: named case still green"}: ${row.caseId}`);
  }
}
/** Run one mutation against cwd, restore even on spawn failure, and prove byte custody. */
export async function runMutation(row: MutationRow, cwd = repo) {
  const file = path.resolve(cwd, row.file);
  const original = await readFile(file);
  const text = original.toString("utf8");
  if (!row.before || text.split(row.before).length !== 2) throw new Error(`Mutation anchor is not unique: ${row.name}`);
  const logs = path.join(cwd, "docs.local/characterization");
  await mkdir(logs, { recursive: true });
  if (pending) throw new Error("Mutation rows must run serially");
  const reportDir = row.kind === "named-test" ? await mkdtemp(path.join(logs, `junit-${row.name}-`)) : undefined;
  pending = { file, original, reportDir };
  const run = async (suffix: string) => {
    const result = await invoke(row, cwd, reportDir ? path.join(reportDir, `${suffix}.xml`) : undefined);
    await writeFile(path.join(logs, `${row.name}-${suffix}.log`), result.stdout + result.stderr);
    return result;
  };
  try {
    let red: Run;
    try { await writeFile(file, text.replace(row.before, row.after)); red = await run("mutated"); }
    finally {
      await writeFile(file, original);
      if (hash(await readFile(file)) !== hash(original)) throw new Error(`Restoration hash mismatch: ${row.name}`);
    }
    const green = await run("restored");
    // Check restored first so a missing test has an unambiguous diagnosis.
    verify(row, green, true);
    verify(row, red, false);
    const target = row.kind === "named-test" ? `; test ${row.testName}` : row.kind === "conformance-case" ? `; case ${row.caseId}` : "";
    process.stdout.write(`${row.name}: mutated FAIL (exit ${red.code}); restored PASS (exit ${green.code})${target}\n`);
  } finally {
    try { if (reportDir) await rm(reportDir, { recursive: true, force: true }); }
    finally { pending = undefined; }
  }
}
if (import.meta.main) for (const row of cases) await runMutation(row);

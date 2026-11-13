// Tests for the seven real survivors of the redrawn 40-mutation sample (sample ids 9, 17, 30,
// 31, 32, 38, 40). Each test asserts what a caller observes. Synthetic inputs only; every write
// goes to a temporary directory; the TTS daemon is a stub.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { normalizeReturnedTimings } from "../src/timing/returned-timings.js";
import { renderSegment as renderQwen3Segment } from "../src/pipelines/job-render/index.js";
import { renderSegment as renderFakeSegment } from "../src/renderers/fake.js";
import { initializeJob } from "../src/job-store.js";
import { parseNarrationJob, type NormalizedNarrationJob } from "../src/schema.js";
import { fixture, runner, spawnChecked, wrappers } from "./compat/harness.js";

const repo = path.resolve(import.meta.dir, "..");
const bun = process.execPath;
const tempDir = (label: string) => mkdtempSync(path.join(os.tmpdir(), `nl-sample-r2-${label}-`));

// ---------------------------------------------------------------------------------------------
// Sample 17 (src/timing/returned-timings.ts:40): daemon word timings carried as offset_ms /
// duration_ms must survive, side by side with the start/end and start_seconds/end_seconds shapes.
// ---------------------------------------------------------------------------------------------

test("sample 17: the three accepted daemon timing shapes normalize to the same seconds", () => {
  const expected = [
    { index: 0, word: "Hello", start: 0.12, end: 0.42 },
    { index: 1, word: "there", start: 0.5, end: 0.875 },
  ];
  const offsetShape = normalizeReturnedTimings({
    word_timings: [
      { word: "Hello", offset_ms: 120, duration_ms: 300 },
      { word: "there", offset_ms: 500, duration_ms: 375 },
    ],
    words: undefined,
    word_boundaries: undefined,
  });
  const startShape = normalizeReturnedTimings({
    word_timings: [
      { word: "Hello", start: 0.12, end: 0.42 },
      { word: "there", start: 0.5, end: 0.875 },
    ],
    words: undefined,
    word_boundaries: undefined,
  });
  const secondsShape = normalizeReturnedTimings({
    word_timings: [
      { word: "Hello", start_seconds: 0.12, end_seconds: 0.42 },
      { word: "there", start_seconds: 0.5, end_seconds: 0.875 },
    ],
    words: undefined,
    word_boundaries: undefined,
  });
  expect(offsetShape).toEqual(expected);
  expect(startShape).toEqual(expected);
  expect(secondsShape).toEqual(expected);
});

test("sample 17: a daemon that returns only offset_ms/duration_ms words is the job's timing source", async () => {
  const dataDir = tempDir("offset");
  const script = "Hello from the local daemon";
  const daemonWords = script.split(" ").map((word, index) => ({ word, offset_ms: 100 + index * 400, duration_ms: 350 }));
  const fetchMock = async (): Promise<Response> =>
    Response.json({
      audio_b64: Buffer.from("synthetic audio bytes").toString("base64"),
      duration_ms: 2400,
      word_timings: daemonWords,
    });
  try {
    const result = await renderQwen3Segment(
      "seg-1",
      { title: "Intro", script },
      {
        artifactsDir: path.join(dataDir, "jobs", "job-1", "artifacts"),
        dataDir,
        jobId: "job-1",
        voiceProfile: "neutral-reader",
        fetch: fetchMock,
      },
      {
        daemon_url: "http://127.0.0.1:1",
        auth_token: "synthetic-token",
        reference_clip: path.join(dataDir, "reference.wav"),
        reference_text: "Synthetic reference.",
        audio_duration_probe: async () => 2.2,
        // A fallback provider that must NOT be consulted when the daemon's timings are usable.
        word_timing_provider: async () => [{ index: 0, word: "fallback", start: 0, end: 9 }],
      },
    );
    const wordsPayload = JSON.parse(readFileSync(result.words_path, "utf8"));
    expect(wordsPayload.timing).toEqual({ status: "available", source: "voicelayer-qwen3" });
    expect(wordsPayload.words).toEqual(
      daemonWords.map((word, index) => ({
        index,
        word: word.word,
        start: word.offset_ms / 1000,
        end: (word.offset_ms + word.duration_ms) / 1000,
      })),
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Sample 9 (src/pipelines/local-tts/index.ts:119): the ` atempo=<v>` note on the runner's `ok`
// line appears exactly when the profile sets atempo.
// ---------------------------------------------------------------------------------------------

async function runnerOkLine(atempo: number | undefined): Promise<string> {
  const f = await fixture();
  try {
    await wrappers(f.root);
    const render: Record<string, string | number> = {
      reference_clip: path.join(f.root, "reference.wav"),
      reference_text: "Synthetic reference.",
      daemon_url: f.url,
      auth_token_file: path.join(f.root, "auth"),
      model: "synthetic-model",
      ...(atempo === undefined ? {} : { atempo }),
    };
    writeFileSync(
      path.join(f.root, "profiles.yaml"),
      `profiles:\n  - id: sample-speed\n    accepted: true\n    renderer: voicelayer-qwen3\n    profile_version: synthetic-v1\n    render:\n${Object.entries(render).map(([key, value]) => `      ${key}: ${value}\n`).join("")}`,
    );
    const result = await runner(f, [
      "--text", "Hello there", "--output", path.join(f.root, "out.wav"), "--reference", "sample-speed",
      "--reference-text", "Synthetic reference.", "--cache-dir", path.join(f.root, "cache"), "--timeout-ms", "10000",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const line = result.stderr.split(/\r?\n/).find((entry) => entry.startsWith("local-tts-runner: ok "));
    expect(line, result.stderr).toBeDefined();
    return line as string;
  } finally {
    await f.close();
  }
}

test("sample 9: the runner's ok line notes atempo only when the profile sets it", async () => {
  const withTempo = await runnerOkLine(1.1);
  expect(withTempo).toContain(" atempo=1.1");
  expect(withTempo.match(/atempo=/g)).toHaveLength(1);
  const withoutTempo = await runnerOkLine(undefined);
  expect(withoutTempo).not.toContain("atempo");
  expect(withoutTempo).toContain("via profile:sample-speed ");
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Sample 30 (src/renderers/fake.ts:11): the fake renderer estimates 2.5 words per second.
// ---------------------------------------------------------------------------------------------

test("sample 30: the fake renderer estimates max(words, 1) / 2.5 seconds and spaces words evenly", async () => {
  const dataDir = tempDir("fake");
  const job: NormalizedNarrationJob = {
    job_id: "job-fake",
    created_at: "2026-01-01T00:00:00.000Z",
    voice_profile: "neutral-reader",
    renderer: "fake",
    segments: [
      { id: "seg-5", title: "Five", script: "one two three four five" },
      { id: "seg-7", title: "Seven", script: "a b c d e f g" },
      { id: "seg-0", title: "Empty", script: "" },
    ],
  };
  try {
    const durations: number[] = [];
    for (const segment of job.segments) {
      const result = await renderFakeSegment(segment.id, segment, job, {
        artifactsDir: path.join(dataDir, "artifacts"),
        dataDir,
      });
      durations.push(result.duration_seconds);
      const words = JSON.parse(readFileSync(result.words_path, "utf8")).words;
      const unit = result.duration_seconds / words.length;
      expect(words.map((word: { start: number; end: number }) => [word.start, word.end])).toEqual(
        words.map((_: unknown, index: number) => [Number((unit * index).toFixed(3)), Number((unit * (index + 1)).toFixed(3))]),
      );
    }
    // 5 words -> 2 s; 7 words -> 2.8 s; no words -> max(0, 1) / 2.5 = 0.4 s.
    expect(durations).toEqual([2, 2.8, 0.4]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Sample 31 (src/job-store.ts:30): a store rooted at `~/<dir>` writes under HOME/<dir>.
// os.homedir() is read once per process, so this runs a child with a temporary HOME.
// ---------------------------------------------------------------------------------------------

test("sample 31: NARRATIONLAYER_DATA_DIR=~/<dir> stores the job under HOME/<dir>", () => {
  const home = tempDir("home");
  try {
    const child = spawnChecked(
      [bun, path.join(repo, "src/cli.ts"), "create-job", path.join(repo, "examples/sample-job.json"), "--json"],
      {
        cwd: repo,
        env: { PATH: process.env.PATH, HOME: home, NARRATIONLAYER_DATA_DIR: "~/sample-store-dir" },
        timeout: 20_000,
      },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const created = JSON.parse(child.stdout.toString());
    const expectedJobPath = path.join(home, "sample-store-dir", "jobs", created.job_id, "job.json");
    expect(created.job_path).toBe(expectedJobPath);
    expect(JSON.parse(readFileSync(expectedJobPath, "utf8")).job_id).toBe(created.job_id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

// ---------------------------------------------------------------------------------------------
// Sample 32 (src/job-store.ts:67): the job file on disk is 2-space JSON plus a newline.
// ---------------------------------------------------------------------------------------------

test("sample 32: the job store writes job.json as JSON.stringify(job, null, 2) + newline", async () => {
  const dataDir = tempDir("store");
  try {
    const job = parseNarrationJob({
      job_id: "job-bytes",
      created_at: "2026-01-01T00:00:00.000Z",
      voice_profile: "neutral-reader",
      renderer: "fake",
      segments: [{ id: "seg-1", title: "Intro", script: "Synthetic text for the byte check." }],
    });
    const record = await initializeJob(job, dataDir);
    expect(readFileSync(record.paths.jobPath, "utf8")).toBe(`${JSON.stringify(job, null, 2)}\n`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Sample 38 (src/mcp-server.ts:44): an unsupported MCP method answers with code -32000.
// ---------------------------------------------------------------------------------------------

test("sample 38: the MCP server answers an unsupported method with error code -32000", () => {
  const dataDir = tempDir("mcp");
  try {
    const request = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "resources/list" });
    const child = spawnChecked([bun, path.join(repo, "src/mcp-server.ts")], {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: dataDir, NARRATIONLAYER_DATA_DIR: dataDir },
      stdin: Buffer.from(`${request}\n`),
      timeout: 20_000,
    });
    const lines = child.stdout.toString().trim().split("\n").filter(Boolean);
    expect(lines, child.stderr.toString()).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: "Unsupported method: resources/list" },
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);

// ---------------------------------------------------------------------------------------------
// Sample 40 (src/cli.ts:62): `status <id>` prints 2-space JSON and the console's newline.
// ---------------------------------------------------------------------------------------------

test("sample 40: `narrationlayer status <id>` prints JSON.stringify(payload, null, 2) exactly", () => {
  const dataDir = tempDir("cli");
  const run = (args: string[]) =>
    spawnChecked([bun, path.join(repo, "src/cli.ts"), ...args], {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: dataDir, NARRATIONLAYER_DATA_DIR: dataDir },
      timeout: 20_000,
    });
  try {
    const created = run(["create-job", path.join(repo, "examples/sample-job.json"), "--json"]);
    expect(created.exitCode, created.stderr.toString()).toBe(0);
    const jobId = JSON.parse(created.stdout.toString()).job_id;
    const status = run(["status", jobId]);
    expect(status.exitCode, status.stderr.toString()).toBe(0);
    const stdout = status.stdout.toString();
    const payload = JSON.parse(stdout);
    expect(payload.job_id).toBe(jobId);
    expect(payload.manifest.segments.length).toBeGreaterThan(0);
    expect(stdout).toBe(`${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);

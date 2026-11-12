import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createJobFromPayload, renderJob } from "../../src/service.js";
import { getDataDir, getManifest, getStatus, pathsForJob } from "../../src/job-store.js";
import { renderSegment } from "../../src/renderers/voicelayer-qwen3.js";
import { planNarrationUtterances } from "../../src/narration-plan.js";
import { normalizeForSpeech } from "../../src/text-normalize.js";
import corpus from "./fixtures/corpus.json";
import { fixture, golden, repo, tool, type Mode } from "./harness.js";
const commit = "f7faa86717f697bf79847eb981da2c3fb1279b67";
function config(f: Awaited<ReturnType<typeof fixture>>, timeoutMs = 10000) {
  return { daemon_url: f.url, auth_token: "synthetic-token", reference_clip: path.join(f.root, "reference.wav"),
    reference_text: "Synthetic reference.", narrationlayer_commit: commit, profile_id: "compat-voice", profile_version: "synthetic-v1", model: "synthetic-model", timeout_ms: timeoutMs,
    // Existing word_timing_provider seam replaces Whisper, keeping real HTTP, audio and repair.
    word_timing_provider: async ({ script, durationSeconds }: { script: string; durationSeconds: number }) => script.split(/\s+/).map((word, index, words) => ({ index, word, start: index * durationSeconds / words.length, end: (index + 1) * durationSeconds / words.length })) };
}
const payload = (scripts: string[]) => ({ job_id: "compat-job", renderer: "voicelayer-qwen3", voice_profile: "compat-voice", segments: scripts.map((script, index) => ({ id: `segment-${index}`, title: `Synthetic ${index}`, duration_seconds: 12, script })) });
test("job service manifest, words, requests and planner goldens", async () => {
  const f = await fixture(true);
  const previous = process.env.NARRATIONLAYER_DATA_DIR;
  try {
    tool("ffmpeg"); tool("ffprobe"); process.env.NARRATIONLAYER_DATA_DIR = path.join(f.root, "data");
    expect(getDataDir()).toBe(path.join(f.root, "data"));
    await createJobFromPayload(payload(corpus));
    const result = await renderJob("compat-job", undefined, { qwen: config(f), external: {} });
    const words = await Promise.all(result.manifest.segments.map(async segment => JSON.parse(await readFile(segment.words_path, "utf8"))));
    const spoken = await Promise.all(result.manifest.segments.map(segment => readFile(`${segment.audio_path}.spoken.txt`, "utf8")));
    await golden("job", f.canonical({ requests: f.requests, manifest: await getManifest("compat-job"), status: await getStatus("compat-job"), words, spoken,
      planned: corpus.map(text => planNarrationUtterances(normalizeForSpeech(text))) }));
  } finally {
    if (previous === undefined) delete process.env.NARRATIONLAYER_DATA_DIR; else process.env.NARRATIONLAYER_DATA_DIR = previous;
    await f.close();
  }
}, 30000);
for (const mode of ["http", "malformed", "timeout"] satisfies Mode[]) {
  test(`job service thrown error golden: ${mode}`, async () => {
    const f = await fixture(true);
    try {
      f.setMode(mode); await createJobFromPayload(payload(["Hello"]), f.root);
      let thrown: unknown;
      try { await renderJob("compat-job", f.root, { qwen: config(f, mode === "timeout" ? 150 : 10000), external: {} }); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(Error);
      await golden(`job-${mode}`, f.canonical({ error: thrown instanceof Error ? { name: thrown.name, message: thrown.message } : thrown,
        requests: f.requests, manifest: await getManifest("compat-job", f.root), status: await getStatus("compat-job", f.root) }));
    } finally { await f.close(); }
  });
}
test("real commit discovery and job/segment confinement remain active", async () => {
  const f = await fixture(true);
  const previous = process.env.NARRATIONLAYER_COMMIT;
  try {
    delete process.env.NARRATIONLAYER_COMMIT;
    const qwen = { ...config(f), narrationlayer_commit: undefined };
    const result = await renderSegment("safe", { title: "Public", script: "Hello" }, { artifactsDir: f.root, dataDir: f.root }, qwen);
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo });
    expect(head.exitCode).toBe(0); expect(result.provenance?.narrationlayer_commit).toBe(head.stdout.toString().trim());
    expect(() => pathsForJob("../escape", f.root)).toThrow();
    await expect(renderSegment("../escape", { title: "Public", script: "Hello" }, { artifactsDir: f.root, dataDir: f.root }, qwen)).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.NARRATIONLAYER_COMMIT; else process.env.NARRATIONLAYER_COMMIT = previous;
    await f.close();
  }
});

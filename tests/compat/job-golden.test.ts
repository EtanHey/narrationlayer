import { test, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createJobFromPayload, renderJob, getRendererConfigFromEnv } from "../../src/service.js";
import { getManifest, getStatus, pathsForJob } from "../../src/job-store.js";
import { renderSegment } from "../../src/renderers/voicelayer-qwen3.js";
import { planNarrationUtterances } from "../../src/narration-plan.js";
import { normalizeForSpeech } from "../../src/text-normalize.js";
import corpus from "./fixtures/corpus.json";
import { fixture, golden, repo, wrappers, argvLog, tool, withEnv, type Mode } from "./harness.js";
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
  try {
    const dataDir = path.join(f.root, "data");
    const wrapperPath = await wrappers(f.root);
    await createJobFromPayload(payload(corpus), dataDir);
    const result = await withEnv({ PATH: `${wrapperPath}${path.delimiter}${process.env.PATH}`, COMPAT_ARGV: path.join(f.root, "argv.jsonl") },
      () => renderJob("compat-job", dataDir, { qwen: config(f), external: {} }));
    const words = await Promise.all(result.manifest.segments.map(async segment => JSON.parse(await readFile(segment.words_path, "utf8"))));
    const spoken = await Promise.all(result.manifest.segments.map(segment => readFile(`${segment.audio_path}.spoken.txt`, "utf8")));
    const temporaries = new Map<string, string>();
    const argv = JSON.parse(JSON.stringify(f.canonical(await argvLog(f.root))).replace(/[^"\\' ]*\/narrationlayer-audio-[A-Za-z0-9]+/g, name => {
      if (!temporaries.has(name)) temporaries.set(name, `$ASSEMBLY_${temporaries.size}`);
      return temporaries.get(name) ?? name;
    }));
    await golden("job", f.canonical({ argv, requests: f.requests, manifest: await getManifest("compat-job", dataDir), status: await getStatus("compat-job", dataDir), words, spoken,
      planned: corpus.map(text => planNarrationUtterances(normalizeForSpeech(text))) }));
  } finally {
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

test("job service probes unauthored duration from the produced file", async () => {
  const f = await fixture(true);
  const ffprobe = tool("ffprobe");
  try {
    await createJobFromPayload({ ...payload([]), segments: [{ id: "probe", title: "Synthetic", script: "One sentence. Another sentence. A final sentence." }] }, f.root);
    const result = await renderJob("compat-job", f.root, { qwen: config(f), external: {} });
    const segment = result.manifest.segments[0];
    const own = Bun.spawnSync([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", segment.audio_path]);
    expect(own.exitCode).toBe(0);
    expect(segment.duration_seconds).toBe(Number(Number(own.stdout.toString()).toFixed(3)));
  } finally { await f.close(); }
});

test("job service daemon auth fallback and env precedence", async () => {
  const f = await fixture(true);
  const other = await fixture(true);
  const secret = path.join(f.root, "secret-token");
  const legacy = path.join(f.root, "legacy-token");
  const envFile = path.join(f.root, "env-token");
  const clean = { NARRATIONLAYER_QWEN3_DAEMON_URL: undefined, NARRATIONLAYER_QWEN3_AUTH_TOKEN: undefined,
    NARRATIONLAYER_QWEN3_AUTH_TOKEN_FILE: undefined, VOICELAYER_TTS_DAEMON_SECRET_FILE: undefined, VOICELAYER_TTS_AUTH_TOKEN_FILE: undefined };
  try {
    await writeFile(secret, " secret-token \n"); await writeFile(legacy, "legacy-token\n"); await writeFile(envFile, "env-file-token\n");
    await createJobFromPayload(payload(["Hello"]), f.root);
    const run = async (env: Record<string, string | undefined>, overrides: Parameters<typeof getRendererConfigFromEnv>[0], token: string) => {
      await withEnv({ ...clean, ...env }, async () => {
        const qwen = { ...config(f), auth_token: undefined, ...overrides };
        const resolved = getRendererConfigFromEnv(qwen);
        // This provider is an existing test seam, intentionally absent from env config.
        resolved.qwen.word_timing_provider = qwen.word_timing_provider;
        await renderJob("compat-job", f.root, resolved);
      });
      expect(f.requests.at(-1)).toMatchObject({ headers: { authorization: `Bearer ${token}` } });
    };
    const fallbacks = { VOICELAYER_TTS_DAEMON_SECRET_FILE: secret, VOICELAYER_TTS_AUTH_TOKEN_FILE: legacy };
    await run(fallbacks, { auth_token: " config-token ", auth_token_file: path.join(f.root, "auth") }, "config-token");
    await run(fallbacks, { auth_token_file: path.join(f.root, "auth") }, "synthetic-token");
    await run(fallbacks, {}, "secret-token");
    await run({ VOICELAYER_TTS_AUTH_TOKEN_FILE: legacy }, {}, "legacy-token");
    await withEnv(clean, async () => {
      await expect(renderJob("compat-job", f.root, { qwen: { ...config(f), auth_token: undefined }, external: {} }))
        .rejects.toThrow("voicelayer-qwen3 requires auth_token or auth_token_file");
    });
    await run({ ...fallbacks, NARRATIONLAYER_QWEN3_AUTH_TOKEN_FILE: envFile }, { auth_token_file: path.join(f.root, "auth") }, "env-file-token");
    await run({ ...fallbacks, NARRATIONLAYER_QWEN3_DAEMON_URL: f.url, NARRATIONLAYER_QWEN3_AUTH_TOKEN: "env-token", NARRATIONLAYER_QWEN3_AUTH_TOKEN_FILE: envFile },
      { daemon_url: other.url, auth_token: "config-token", auth_token_file: path.join(f.root, "auth") }, "env-token");
    expect(f.requests).toHaveLength(6); expect(other.requests).toHaveLength(0);
  } finally { await f.close(); await other.close(); }
});

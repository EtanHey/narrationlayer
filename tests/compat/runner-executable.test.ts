import { test, expect } from "bun:test";
import { readFile, writeFile, access, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { splitForBreathing } from "../../src/plan/breathing.js";
import { normalizeForSpeech } from "../../src/text-normalize.js";
import corpus from "./fixtures/corpus.json";
import { fixture, golden, wrappers, runner, argvLog, stderrClass, digest, stableArgv, assertRootProfile, repo, tool, type Mode } from "./harness.js";
const exists = (file: string) => access(file).then(() => true, () => false);
const argsFor = (f: Awaited<ReturnType<typeof fixture>>, text: string, reference = path.join(f.root, "reference.wav")) => [
  "--text", text, "--output", path.join(f.root, "out.wav"), "--reference", reference,
  "--reference-text", "Synthetic reference.", "--daemon-url", `${f.url}///`, "--auth-token-file", path.join(f.root, "auth"),
  "--cache-dir", path.join(f.root, "cache"), "--timeout-ms", "10000",
];
async function profile(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(path.join(f.root, "profiles.yaml"), `profiles:\n  - id: compat-voice\n    accepted: true\n    renderer: voicelayer-qwen3\n    profile_version: synthetic-v1\n    render:\n      reference_clip: ${f.root}/reference.wav\n      reference_text: Profile text.\n      daemon_url: ${f.url}\n      auth_token_file: ${f.root}/auth\n      model: synthetic-model\n      comma_pause_seconds: 0.22\n      eq_highshelf_hz: 4000\n      eq_highshelf_gain_db: 0\n      atempo: 1\n      loudness_target_db: -20\n`);
}
test("runner executable goldens: direct reference, named profile, cache, real tool argv", async () => {
  const f = await fixture();
  try {
    await wrappers(f.root); await profile(f);
    const results = [];
    for (const text of corpus) for (const named of [false, true]) {
      const args = argsFor(f, text, named ? "compat-voice" : undefined);
      if (named) args.push("--daemon-url", "http://127.0.0.1:1", "--auth-token-file", "missing-flag-token");
      const start = f.requests.length;
      const result = await runner(f, args);
      expect(result.code, result.stderr).toBe(0);
      const receipt = JSON.parse(await readFile(path.join(f.root, "out.wav.cache.json"), "utf8"));
      const preimage = { spokenText: normalizeForSpeech(text), referenceClip: path.join(f.root, "reference.wav"), referenceText: "Synthetic reference.",
        ...(named ? { profileId: "compat-voice", profileVersion: "synthetic-v1", model: "synthetic-model" } : {}),
        params: named ? { eqHighshelfHz: 4000, eqHighshelfGainDb: 0, loudnessTargetDb: -20, atempo: 1, commaPauseSeconds: 0.22 } : {} };
      expect(receipt.cacheKey).toBe(digest(JSON.stringify(preimage)));
      expect(await exists(path.join(f.root, "cache", `${receipt.cacheKey}.wav`))).toBe(true);
      const output = await readFile(path.join(f.root, "out.wav"));
      const probe = Bun.spawnSync([tool("ffprobe"), "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels,bits_per_sample", "-of", "json", path.join(f.root, "out.wav")]);
      expect(probe.exitCode).toBe(0);
      if (named) {
        const volume = Bun.spawnSync([tool("ffmpeg"), "-i", path.join(f.root, "out.wav"), "-af", "volumedetect", "-f", "null", "-"]);
        expect(volume.exitCode).toBe(0);
        const mean = Number(volume.stderr.toString().match(/mean_volume:\s*(-?[0-9.]+)/)?.[1]);
        expect(Number.isFinite(mean), "volumedetect must report a numeric mean_volume").toBe(true);
        expect(Math.abs(mean - (-20))).toBeLessThanOrEqual(1);
      }
      await unlink(path.join(f.root, "out.wav.spoken.txt"));
      const hit = await runner(f, args);
      expect(hit.code).toBe(0); expect(stderrClass(hit.stderr)).toBe("cache HIT");
      expect(await readFile(path.join(f.root, "out.wav"))).toEqual(output);
      results.push({ referenceKind: named ? "profile" : "direct", requests: f.canonical(f.requests.slice(start)), spoken: await readFile(path.join(f.root, "out.wav.spoken.txt"), "utf8"),
        // Verify the real path-dependent key above, then freeze its canonical preimage and digest.
        keyPreimage: f.canonical(preimage), receipt: { ...receipt, cacheKey: digest(JSON.stringify(f.canonical(preimage))) },
        pieces: splitForBreathing(normalizeForSpeech(text), 0.55, 0.22), format: JSON.parse(probe.stdout.toString()).streams, exit: result.code, stderr: stderrClass(result.stderr) });
    }
    await golden("runner", { results, argv: f.canonical(await stableArgv(f.root)) });
    // The runner currently never calls ffprobe. The wrapper's empty trace is deliberate.
    expect((await argvLog(f.root)).filter(call => call.tool === "ffprobe")).toEqual([]);
    await assertRootProfile("neutral-public");
    const base = await runner(f, argsFor(f, "Hello", "neutral-public"));
    expect(base.code).toBe(1); expect(base.stderr).toContain('uses renderer "fake"');
  } finally { await f.close(); }
}, 60000);
for (const mode of ["http", "malformed", "timeout"] satisfies Mode[]) {
  test(`runner executable failure golden: ${mode}`, async () => {
    const f = await fixture();
    try {
      await wrappers(f.root); await profile(f); f.setMode(mode);
      const args = [...argsFor(f, "Hello"), ...(mode === "timeout" ? ["--timeout-ms", "150"] : [])];
      const fresh = await runner(f, args);
      expect(fresh.code).toBe(1);
      expect(await exists(path.join(f.root, "out.wav"))).toBe(false);
      await writeFile(path.join(f.root, "out.wav"), "stale output");
      await writeFile(path.join(f.root, "out.wav.cache.json"), "stale receipt");
      const stale = await runner(f, args);
      expect(stale.code).toBe(1);
      // Baseline bug: HTTP/validation/timeout failures keep an existing output, but clear its receipt.
      expect(await readFile(path.join(f.root, "out.wav"), "utf8")).toBe("stale output");
      expect(await exists(path.join(f.root, "out.wav.cache.json"))).toBe(false);
      await golden(`runner-${mode}`, { fresh: { code: fresh.code, stderr: stderrClass(fresh.stderr) }, stale: { code: stale.code, stderr: stderrClass(stale.stderr) }, requests: f.canonical(f.requests) });
    } finally { await f.close(); }
  });
}
test("runner removes intermediate output when breathing throws after a successful full take", async () => {
  const f = await fixture();
  try {
    await wrappers(f.root); await profile(f); f.failAt(3, "timeout");
    const result = await runner(f, [...argsFor(f, "First. Second.", "compat-voice"), "--timeout-ms", "150"]);
    expect(result.code).toBe(1);
    expect(await exists(path.join(f.root, "out.wav.breath-0.wav"))).toBe(false);
    expect(await exists(path.join(f.root, "out.wav.cache.json"))).toBe(false);
    // Baseline also retains the initial full take after a later breathing failure.
    expect(await exists(path.join(f.root, "out.wav"))).toBe(true);
  } finally { await f.close(); }
});
test("runner HTTP failure during breathing leaves the baseline intermediate file", async () => {
  const f = await fixture();
  try {
    await wrappers(f.root); await profile(f); f.failAt(3, "http");
    const result = await runner(f, argsFor(f, "First. Second.", "compat-voice"));
    expect(result.code).toBe(1);
    expect(stderrClass(result.stderr)).toBe("daemon /synthesize failed (500): synthetic failure");
    expect(f.requests).toHaveLength(3);
    expect(await exists(path.join(f.root, "out.wav.breath-0.wav"))).toBe(true);
    expect(await exists(path.join(f.root, "out.wav.cache.json"))).toBe(false);
    expect(await exists(path.join(f.root, "out.wav"))).toBe(true);
  } finally { await f.close(); }
}, 30000);

// Characterize process.exit versus throw before moving orchestration into a library.
for (const mode of ["http", "malformed", "timeout"] satisfies Mode[]) for (const call of [1, 2, 3]) {
  test(`runner failure custody: ${mode} at synthesis ${call}`, async () => {
    const f = await fixture();
    try {
      await wrappers(f.root); await profile(f); f.failAt(call, mode);
      const result = await runner(f, [...argsFor(f, "First. Second.", "compat-voice"), "--timeout-ms", "150"]);
      expect(result.code).toBe(1);
      const message = mode === "http" ? "daemon /synthesize failed (500): synthetic failure"
        : mode === "malformed" ? "daemon response missing audio_b64" : "The operation was aborted.";
      expect(result.stderr).toBe(`local-tts-runner: ${message}\n`);
      expect(f.requests).toHaveLength(call);
      const leftovers = (await readdir(f.root)).filter(name => name.startsWith("out.wav")).sort();
      const preserved = ["out.wav.breath-0.raw", "out.wav.breath-0.tempo.wav", "out.wav.breath-0.wav", "out.wav.sil-0.wav"];
      expect(leftovers).toEqual(call === 1 ? [] : ["out.wav", ...(call === 3 && mode !== "timeout" ? preserved : [])]);
      if (call > 1) {
        const output = await readFile(path.join(f.root, "out.wav"));
        expect(output.subarray(0, 4).toString()).toBe("RIFF");
        expect(output.length).toBeGreaterThan(44);
      }
      if (call === 3 && mode !== "timeout") expect(await readFile(path.join(f.root, "out.wav.breath-0.raw"))).toEqual(f.wav);
    } finally { await f.close(); }
  });
}
test("named profile keeps absent-field flags and overrides them when daemon and token are set", async () => {
  const cli = await fixture(); const selected = await fixture();
  try {
    await wrappers(cli.root); await profile(cli);
    const file = path.join(cli.root, "profiles.yaml");
    const full = await readFile(file, "utf8");
    await writeFile(file, full.replace(`      daemon_url: ${cli.url}\n`, "").replace(`      auth_token_file: ${cli.root}/auth\n`, ""));
    const args = [...argsFor(cli, "Hello", "compat-voice"), "--no-cache"];
    const inherited = await runner(cli, args);
    expect(inherited.code, inherited.stderr).toBe(0);
    expect(cli.requests).toHaveLength(1); expect(selected.requests).toHaveLength(0);
    await writeFile(path.join(selected.root, "auth"), "profile-token");
    await writeFile(file, full.replace(cli.url, selected.url).replace(`${cli.root}/auth`, `${selected.root}/auth`));
    const overridden = await runner(cli, args);
    expect(overridden.code, overridden.stderr).toBe(0);
    expect(cli.requests).toHaveLength(1); expect(selected.requests).toHaveLength(1);
    expect(selected.requests[0]).toMatchObject({ url: `${selected.url}/synthesize`, headers: { authorization: "Bearer profile-token" } });
    expect(JSON.parse(await readFile(path.join(cli.root, "out.wav.cache.json"), "utf8")).cacheEnabled).toBe(false);
  } finally { await cli.close(); await selected.close(); }
});
test("runner entry root lookup without profile-file environment", async () => {
  const f = await fixture();
  try {
    await assertRootProfile("qwen3-voice");
    const result = await runner(f, argsFor(f, "Hello", "qwen3-voice"), false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('voice profile "qwen3-voice" reference clip missing on disk: /absolute/path/to/local/reference.wav');
    expect(result.stderr).not.toContain("is not registered");
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});

test("root profile overrides fail with a public fixture-conflict diagnostic", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "profiles.local.yaml"), "profiles:\n  - id: qwen3-voice\n");
    await expect(assertRootProfile("qwen3-voice", f.root)).rejects.toThrow("Characterization fixture conflict: profiles.local.yaml overrides qwen3-voice; use a clean worktree");
  } finally { await f.close(); }
});
test("golden update mode fails visibly and is forbidden in CI", async () => {
  const file = path.join(import.meta.dir, "fixtures/runner.golden.json"), original = await readFile(file, "utf8");
  const script = `import {golden} from ${JSON.stringify(path.join(import.meta.dir, "harness.ts"))}; await golden("runner", JSON.parse(await Bun.file(${JSON.stringify(file)}).text()));`;
  for (const CI of [undefined, "1"]) {
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: repo, env: { ...process.env, CI, UPDATE_COMPAT_GOLDENS: "1" }, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(stderr).toContain(CI ? "Golden updates are forbidden in CI" : "re-run without UPDATE_COMPAT_GOLDENS");
    expect(await readFile(file, "utf8")).toBe(original);
  }
});

test("stderr timeout classification requires the exact abort diagnostic", () => {
  expect(stderrClass("local-tts-runner: The operation was aborted.\n")).toBe("The operation was aborted.");
  for (const message of ["abort requested by another failure", "The operation was aborted. unrelated failure", "cannot abort cache write"]) {
    const stderr = `local-tts-runner: ${message}\n`;
    expect(stderrClass(stderr)).toBe(stderr);
  }
});

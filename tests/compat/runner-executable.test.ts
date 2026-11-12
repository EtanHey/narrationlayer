import { test, expect } from "bun:test";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { splitForBreathing } from "../../bin/local-tts-runner.js";
import { normalizeForSpeech } from "../../src/text-normalize.js";
import corpus from "./fixtures/corpus.json";
import { fixture, golden, wrappers, runner, argvLog, stderrClass, digest, tool, type Mode } from "./harness.js";
const exists = (file: string) => access(file).then(() => true, () => false);
const argsFor = (f: Awaited<ReturnType<typeof fixture>>, text: string, reference = path.join(f.root, "reference.wav")) => [
  "--text", text, "--output", path.join(f.root, "out.wav"), "--reference", reference,
  "--reference-text", "Synthetic reference.", "--daemon-url", `${f.url}///`, "--auth-token-file", path.join(f.root, "auth"),
  "--cache-dir", path.join(f.root, "cache"), "--timeout-ms", "150",
];
async function profile(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(path.join(f.root, "profiles.yaml"), `profiles:\n  - id: compat-voice\n    accepted: true\n    renderer: voicelayer-qwen3\n    profile_version: synthetic-v1\n    render:\n      reference_clip: ${f.root}/reference.wav\n      reference_text: Profile text.\n      daemon_url: ${f.url}\n      auth_token_file: ${f.root}/auth\n      model: synthetic-model\n      comma_pause_seconds: 0.22\n      eq_highshelf_hz: 4000\n      eq_highshelf_gain_db: 0\n      atempo: 1\n      loudness_target_db: -20\n`);
}
test("runner executable goldens: direct reference, named profile, cache, real tool argv", async () => {
  const f = await fixture();
  try {
    await wrappers(f.root); await profile(f);
    const results = [];
    for (const [index, text] of corpus.entries()) {
      const named = index === 3;
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
      const hit = await runner(f, args);
      expect(hit.code).toBe(0); expect(stderrClass(hit.stderr)).toBe("cache HIT");
      expect(await readFile(path.join(f.root, "out.wav"))).toEqual(output);
      results.push({ requests: f.canonical(f.requests.slice(start)), spoken: await readFile(path.join(f.root, "out.wav.spoken.txt"), "utf8"),
        // Verify the real path-dependent key above, then freeze its canonical preimage and digest.
        keyPreimage: f.canonical(preimage), receipt: { ...receipt, cacheKey: digest(JSON.stringify(f.canonical(preimage))) },
        pieces: splitForBreathing(normalizeForSpeech(text), 0.55, 0.22), format: JSON.parse(probe.stdout.toString()).streams, exit: result.code, stderr: stderrClass(result.stderr) });
    }
    await golden("runner", { results, argv: f.canonical(await argvLog(f.root)) });
    // The runner currently never calls ffprobe. The wrapper's empty trace is deliberate.
    expect((await argvLog(f.root)).filter(call => call.tool === "ffprobe")).toEqual([]);
    const base = await runner(f, argsFor(f, "Hello", "neutral-public"));
    expect(base.code).toBe(1); expect(base.stderr).toContain('uses renderer "fake"');
  } finally { await f.close(); }
}, 30000);
for (const mode of ["http", "malformed", "timeout"] satisfies Mode[]) {
  test(`runner executable failure golden: ${mode}`, async () => {
    const f = await fixture();
    try {
      await wrappers(f.root); await profile(f); f.setMode(mode);
      const args = argsFor(f, "Hello");
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
    const result = await runner(f, argsFor(f, "First. Second.", "compat-voice"));
    expect(result.code).toBe(1);
    expect(await exists(path.join(f.root, "out.wav.breath-0.wav"))).toBe(false);
    expect(await exists(path.join(f.root, "out.wav.cache.json"))).toBe(false);
    // Baseline also retains the initial full take after a later breathing failure.
    expect(await exists(path.join(f.root, "out.wav"))).toBe(true);
  } finally { await f.close(); }
});
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
    const result = await runner(f, argsFor(f, "Hello", "qwen3-voice"), false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('voice profile "qwen3-voice" reference clip missing on disk:');
    expect(result.stderr).not.toContain("is not registered");
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});

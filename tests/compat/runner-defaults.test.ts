import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { splitForBreathing } from "../../src/plan/breathing.js";
import { normalizeForSpeech } from "../../src/text-normalize.js";
import { LOCAL_TTS_RENDER_VERSION } from "../../src/pipelines/local-tts/take-cache.js";
import { argvLog, defaultsCases as cases, defaultsProfile, defaultsText, digest, fixture, golden, runner, stderrClass, tool, wrappers } from "./harness.js";

for (const variant of cases) test(`runner defaults: ${variant.name}`, async () => {
  const f = await fixture();
  try {
    await wrappers(f.root);
    await defaultsProfile(f, variant.render);
    const text = defaultsText;
    const output = path.join(f.root, "out.wav");
    const result = await runner(f, ["--text", text, "--output", output, "--reference", "compat-defaults",
      "--reference-text", "Synthetic reference.", "--cache-dir", path.join(f.root, "cache"), "--timeout-ms", "10000"]);
    expect(result.code, result.stderr).toBe(0);
    const preimage = {
      spokenText: normalizeForSpeech(text), referenceClip: path.join(f.root, "reference.wav"), referenceText: "Synthetic reference.",
      profileId: "compat-defaults", profileVersion: "synthetic-v1", model: "synthetic-model", params: variant.params,
      ...(LOCAL_TTS_RENDER_VERSION === 1 ? {} : { renderVersion: LOCAL_TTS_RENDER_VERSION }),
    };
    const receipt = JSON.parse(await readFile(`${output}.cache.json`, "utf8"));
    expect(receipt.cacheKey).toBe(digest(JSON.stringify(preimage)));
    expect(await readFile(path.join(f.root, "cache", `${receipt.cacheKey}.wav`))).toEqual(await readFile(output));
    const probe = Bun.spawnSync([tool("ffprobe"), "-v", "error", "-show_entries",
      "stream=codec_name,sample_rate,channels,bits_per_sample", "-of", "json", output], { timeout: 10000 });
    expect(probe.exitCode, probe.stderr.toString()).toBe(0);
    const breathingNote = result.stderr.match(/ breathing=[^\n]+?\)/)?.[0];
    expect(breathingNote).toBeDefined();
    const argv = await argvLog(f.root);
    expect(argv.filter(call => call.tool === "ffprobe")).toEqual([]);
    await golden(`runner-defaults-${variant.name}`, {
      results: [{ requests: f.canonical(f.requests), spoken: await readFile(`${output}.spoken.txt`, "utf8"),
        keyPreimage: f.canonical(preimage), receipt: { ...receipt, cacheKey: digest(JSON.stringify(f.canonical(preimage))) },
        pieces: splitForBreathing(normalizeForSpeech(text), variant.sentence, variant.comma),
        format: JSON.parse(probe.stdout.toString()).streams, exit: result.code, stderr: stderrClass(result.stderr), breathingNote }],
      argv: f.canonical(argv),
    });
  } finally { await f.close(); }
}, 30000);

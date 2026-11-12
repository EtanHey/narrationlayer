import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { splitForBreathing } from "../../src/plan/breathing.js";
import { normalizeForSpeech } from "../../src/text-normalize.js";
import { LOCAL_TTS_RENDER_VERSION } from "../../src/pipelines/local-tts/take-cache.js";
import { argvLog, digest, fixture, golden, runner, stderrClass, tool, wrappers } from "./harness.js";

const cases = [
  { name: "sentence-only", render: { sentence_pause_seconds: 0.41, atempo: 1 }, params: { atempo: 1, sentencePauseSeconds: 0.41 }, sentence: 0.41, comma: 0.22 },
  { name: "comma-only", render: { comma_pause_seconds: 0.17, atempo: 1 }, params: { atempo: 1, commaPauseSeconds: 0.17 }, sentence: 0.55, comma: 0.17 },
  { name: "no-tempo", render: { sentence_pause_seconds: 0.41, comma_pause_seconds: 0.17 }, params: { sentencePauseSeconds: 0.41, commaPauseSeconds: 0.17 }, sentence: 0.41, comma: 0.17 },
];

for (const variant of cases) test(`runner defaults: ${variant.name}`, async () => {
  const f = await fixture();
  try {
    await wrappers(f.root);
    const render = {
      reference_clip: path.join(f.root, "reference.wav"), reference_text: "Synthetic reference.",
      daemon_url: f.url, auth_token_file: path.join(f.root, "auth"), model: "synthetic-model", ...variant.render,
    };
    await writeFile(path.join(f.root, "profiles.yaml"), `profiles:\n  - id: compat-defaults\n    accepted: true\n    renderer: voicelayer-qwen3\n    profile_version: synthetic-v1\n    render:\n${Object.entries(render).map(([key, value]) => `      ${key}: ${value}\n`).join("")}`);
    const text = "First clause, second clause. Last sentence.";
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

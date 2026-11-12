// Run with: bun tests/compat/mutations.ts. Never run concurrently with another test command.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { repo, tool } from "./harness.js";
const cases = [
  ["job-silence-pad", "src/audio.ts", "String(chunk.pauseAfterSeconds)", "String(chunk.pauseAfterSeconds * 2)", "job service"],
  ["job-silence-rate", "src/audio.ts", "anullsrc=channel_layout=mono:sample_rate=24000", "anullsrc=channel_layout=mono:sample_rate=22050", "job service"],
  ["runner-newlines", "bin/local-tts-runner.ts", "      spokenText,\n      sentencePad,", '      spokenText: spokenText.replace(/\\n/g, " "),\n      sentencePad,', "runner executable goldens"],
  ["job-pause", "src/narration-plan.ts", "DEFAULT_SENTENCE_PAUSE_SECONDS = 0.55", "DEFAULT_SENTENCE_PAUSE_SECONDS = 0.56", "job service manifest"],
  ["runner-pause", "bin/local-tts-runner.ts", "resolved.sentencePauseSeconds ?? 0.55", "resolved.sentencePauseSeconds ?? 0.56", "runner executable goldens"],
  ["runner-auth", "src/backends/qwen3-daemon.ts", "Authorization: `Bearer ${args.authToken}`", '"X-Dropped-Authorization": `Bearer ${args.authToken}`', "runner executable"],
  ["job-auth", "src/backends/qwen3-daemon.ts", "Authorization: `Bearer ${args.authToken}`", '"X-Dropped-Authorization": `Bearer ${args.authToken}`', "job service"],
  ["profile-base", "bin/local-tts-runner.ts", 'findProfile(ref, path.resolve(import.meta.dir, ".."))', 'findProfile(ref, path.resolve(import.meta.dir, "../.."))', "runner entry root lookup without profile-file environment"],
  ["failure-cleanup", "bin/local-tts-runner.ts", "await unlink(p);", "/* scratch: leave intermediate output behind */", "runner removes intermediate output"],
  ["spoken-form", "src/text-normalize.ts", '`pull request ${referenceNumber(n)}`', '`changed request ${referenceNumber(n)}`', "runner executable goldens"],
  ["silent-http", "src/pipelines/job-render/synthesis.ts", "throw new Error(`voicelayer-qwen3 synthesize failed (${failure.status}): ${failure.body || failure.statusText}`);", "return {};", "job service thrown error golden: http"],
  ["job-probe-default", "src/pipelines/job-render/index.ts", "normalizeDuration(await (config.audio_duration_probe ?? probeAudioDurationSeconds)(audioPath))", "normalizeDuration(await (config.audio_duration_probe ?? (async () => undefined))(audioPath))", "job service probes unauthored"],
  ["job-probe-scale-1.05", "src/audio.ts", "return Number(value.toFixed(3));", "return Number((value * 1.05).toFixed(3));", "job service probes unauthored"],
  ["job-probe-scale-0.9", "src/audio.ts", "return Number(value.toFixed(3));", "return Number((value * 0.9).toFixed(3));", "job service probes unauthored"],
  ["job-probe-scale-1.5", "src/audio.ts", "return Number(value.toFixed(3));", "return Number((value * 1.5).toFixed(3));", "job service probes unauthored"],
  ["runner-loudness-result", "bin/local-tts-runner.ts", "\n  await rename(tmpPath, output);", "\n  await unlink(tmpPath);", "runner executable goldens"],
  ["runner-hit-sidecar", "bin/local-tts-runner.ts", "    await writeFile(`${output}.spoken.txt`, spokenText, \"utf8\");", "/* scratch: omit HIT spoken sidecar */", "runner executable goldens"],
  ["job-secret-fallback", "src/pipelines/job-render/config.ts", "    process.env.VOICELAYER_TTS_DAEMON_SECRET_FILE ||\n", "", "job service daemon auth"],
  ["job-env-daemon_url", "src/service.ts", "process.env.NARRATIONLAYER_QWEN3_DAEMON_URL ?? overrides.daemon_url", "overrides.daemon_url ?? process.env.NARRATIONLAYER_QWEN3_DAEMON_URL", "job service daemon auth"],
  ["job-env-auth_token", "src/service.ts", "process.env.NARRATIONLAYER_QWEN3_AUTH_TOKEN ?? overrides.auth_token", "overrides.auth_token ?? process.env.NARRATIONLAYER_QWEN3_AUTH_TOKEN", "job service daemon auth"],
  ["job-env-auth_token_file", "src/service.ts", "process.env.NARRATIONLAYER_QWEN3_AUTH_TOKEN_FILE ?? overrides.auth_token_file", "overrides.auth_token_file ?? process.env.NARRATIONLAYER_QWEN3_AUTH_TOKEN_FILE", "job service daemon auth"],
  ["stderr-abort-class", "tests/compat/harness.ts", "The operation was aborted\\.(?=\\r?$)", "[^\\n]*abort[^\\n]*", "stderr timeout classification"],
  ["job-assembly-dir", "src/audio.ts", "path.join(os.tmpdir(), \"narrationlayer-audio-\")", "path.join(path.dirname(outputPath), \"narrationlayer-audio-\")", "job service manifest"],
  ["runner-http-exit", "bin/local-tts-runner.ts", "fail(\n        `daemon /synthesize failed", "throw new Error(\n        `daemon /synthesize failed", "runner HTTP failure during breathing"],
] satisfies string[][];
await mkdir(path.join(repo, "docs.local/characterization"), { recursive: true });
for (const [name, relative, before, after, pattern] of cases) {
  const file = path.join(repo, relative); const original = await readFile(file, "utf8");
  if (original.split(before).length !== 2) throw new Error(`Mutation anchor is not unique: ${name}`);
  const run = async (suffix: string) => {
    const child = Bun.spawn([tool("bun"), "test", "tests/compat", "--test-name-pattern", pattern], { cwd: repo, env: { ...process.env, UPDATE_COMPAT_GOLDENS: "0" }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await writeFile(path.join(repo, `docs.local/characterization/${name}-${suffix}.log`), stdout + stderr);
    return code;
  };
  let red: number;
  try { await writeFile(file, original.replace(before, after)); red = await run("mutated"); }
  finally { await writeFile(file, original); }
  if (red === 0) throw new Error(`Mutation survived: ${name}`);
  const green = await run("restored");
  if (green !== 0) throw new Error(`Restored test failed: ${name}`);
  process.stdout.write(`${name}: mutated FAIL (exit ${red}); restored PASS (exit ${green})\n`);
}

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
  ["runner-auth", "bin/local-tts-runner.ts", "Authorization: `Bearer ${opts.authToken}`", '"X-Dropped-Authorization": `Bearer ${opts.authToken}`', "runner executable"],
  ["job-auth", "src/renderers/voicelayer-qwen3.ts", "Authorization: `Bearer ${args.authToken}`", '"X-Dropped-Authorization": `Bearer ${args.authToken}`', "job service"],
  ["profile-base", "bin/local-tts-runner.ts", 'findProfile(ref, path.resolve(import.meta.dir, ".."))', 'findProfile(ref, path.resolve(import.meta.dir, "../.."))', "runner entry root lookup without profile-file environment"],
  ["failure-cleanup", "bin/local-tts-runner.ts", "await unlink(p);", "/* scratch: leave intermediate output behind */", "runner removes intermediate output"],
  ["spoken-form", "src/text-normalize.ts", '`pull request ${referenceNumber(n)}`', '`changed request ${referenceNumber(n)}`', "runner executable goldens"],
  ["silent-http", "src/renderers/voicelayer-qwen3.ts", "throw new Error(`voicelayer-qwen3 synthesize failed (${response.status}): ${body || response.statusText}`);", "return {};", "job service thrown error golden: http"],
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

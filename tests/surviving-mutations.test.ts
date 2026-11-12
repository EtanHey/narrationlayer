import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deriveSpeechAliases } from "../src/text-normalize.js";
import { normalizeWordTimingsForScript } from "../src/word-timing-repair.js";
import { renderSegment } from "../src/renderers/external-command.js";

// A configured pronunciation is absent from the built-in normalization map.
test("single display token retains its configured speech alias between anchors", () => {
  expect(deriveSpeechAliases("start Zephyr end", "start zeff er end"))
    .toEqual([{ term: "Zephyr", spoken: "zeff er" }]);
  expect(deriveSpeechAliases("start ordinary phrase end", "start different words end"))
    .toEqual([]);
});

test("repair rounds merged word boundaries to milliseconds", () => {
  const result = normalizeWordTimingsForScript("sun-rise glows", [
    { index: 0, word: "sun", start: 0.123456, end: 0.4 },
    { index: 1, word: "rise", start: 0.4, end: 0.876543 },
    { index: 2, word: "glows", start: 0.9, end: 1.4 },
  ], 1.4);
  expect(result.repaired).toBe(true);
  expect(result.words[0]).toEqual({ index: 0, word: "sun-rise", start: 0.123, end: 0.877 });
});

async function stub(root: string, name: string, source: string) {
  const file = path.join(root, name);
  await writeFile(file, `#!${process.execPath}\n${source}\n`);
  await chmod(file, 0o755);
  return file;
}

async function isolated(root: string, source: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, "--eval", source], {
    cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(stdout);
  } finally { clearTimeout(timer); }
}

test("audio probe rounds ffprobe duration to milliseconds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nl-probe-round-"));
  try {
    await stub(root, "ffprobe", 'console.log("1.234567");');
    const module = new URL("../src/audio.ts", import.meta.url).href;
    const duration = await isolated(root,
      `import {probeAudioDurationSeconds} from ${JSON.stringify(module)}; console.log(JSON.stringify(await probeAudioDurationSeconds("synthetic.wav")));`,
      { PATH: root });
    expect(duration).toBe(1.235);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("external renderer estimates duration when probe and requested duration are absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nl-estimate-"));
  try {
    const runner = await stub(root, "renderer", 'await Bun.write(process.argv[2], "synthetic placeholder");');
    const result = await renderSegment("intro", { id: "intro", title: "Intro", script: "one two three four five" },
      { artifactsDir: path.join(root, "artifacts"), dataDir: root, jobId: "synthetic" },
      { command: runner, args: ["{output_path}"], audio_duration_probe: async () => undefined,
        timing_backend: "estimated", timeout_ms: 20_000 });
    expect(result.duration_seconds).toBe(2);
    const payload = JSON.parse(await readFile(result.words_path, "utf8"));
    expect(payload.words.at(-1)).toMatchObject({ word: "five", end: 2 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("whisper discovers a home-relative model and passes its full path to the process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nl-whisper-home-"));
  try {
    const cache = path.join(root, ".cache/whisper");
    await mkdir(cache, { recursive: true });
    const model = path.join(cache, "ggml-large-v3-turbo.bin");
    await writeFile(model, "synthetic model placeholder");
    const log = path.join(root, "argv.json");
    const binary = await stub(root, "whisper-stub", `
const args = process.argv.slice(2);
await Bun.write(${JSON.stringify(log)}, JSON.stringify(args));
await Bun.write(args[args.indexOf("-of") + 1] + ".json", JSON.stringify({transcription: []}));`);
    const module = new URL("../src/word-timings.ts", import.meta.url).href;
    expect(await isolated(root,
      `import {runWhisperCliWordTimings} from ${JSON.stringify(module)}; console.log(JSON.stringify(await runWhisperCliWordTimings("synthetic.wav", {whisper_binary: ${JSON.stringify(binary)}})));`,
      { HOME: root, NARRATIONLAYER_WHISPER_MODEL: undefined }))
      .toEqual({ source: "whisper-cli", words: [] });
    const args = JSON.parse(await readFile(log, "utf8"));
    expect(args[args.indexOf("-m") + 1]).toBe(model);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

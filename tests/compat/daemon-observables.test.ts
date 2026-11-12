// These tests observe client timeouts through setTimeout; update them if the client changes timer mechanisms.
import { expect, test, spyOn } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderSegment } from "../../src/renderers/voicelayer-qwen3.js";
import { fixture, repo, stderrClass } from "./harness.js";

test("job daemon observables: default and configured timeout, trailing slash", async () => {
  const f = await fixture();
  const timers: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign((...args: Parameters<typeof setTimeout>) => {
    timers.push(args[1] ?? 0);
    return realSetTimeout(...args);
  }, realSetTimeout));
  try {
    const render = (timeout_ms?: number) => renderSegment("sample", { title: "Sample", script: "Hello" },
      { dataDir: f.root, artifactsDir: path.join(f.root, "artifacts"), fetch: async (url, init) => {
        expect(url).toBe(`${f.url}/synthesize`);
        return fetch(url, init);
      } }, {
        daemon_url: `${f.url}///`, auth_token: "synthetic-token", reference_clip: path.join(f.root, "reference.wav"),
        reference_text: "Synthetic reference.", narrationlayer_commit: "synthetic", reference_clip_sha: "synthetic",
        audio_duration_probe: async () => 0.2, timeout_ms,
      });
    expect((await render()).status).toBe("rendered");
    expect(timers).toContain(30_000);
    timers.length = 0;
    expect((await render(1000)).status).toBe("rendered");
    expect(timers).toContain(1000);
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) expect(request).toMatchObject({ url: `${f.url}/synthesize` });
    f.setMode("timeout");
    timers.length = 0;
    await expect(render(50)).rejects.toThrow("The operation was aborted.");
    expect(timers).toContain(50);
    expect(f.requests).toHaveLength(3);
  } finally { timer.mockRestore(); await f.close(); }
});

test("runner daemon observables: default and CLI timeout, trailing slash", async () => {
  const f = await fixture();
  try {
    // Observe the long default in a separate process without waiting two minutes.
    const preload = path.join(f.root, "observe-timers.ts");
    const log = path.join(f.root, "timers.jsonl");
    const urls = path.join(f.root, "urls.jsonl");
    await writeFile(preload, `import {appendFileSync} from 'node:fs';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => { appendFileSync(${JSON.stringify(urls)}, JSON.stringify(url)+'\\n'); return realFetch(url, init); };
const original = globalThis.setTimeout;
globalThis.setTimeout = (...args) => { appendFileSync(${JSON.stringify(log)}, JSON.stringify(args[1])+'\\n'); return original(...args); };
`);
    const run = async (timeout?: number) => {
      await writeFile(log, "");
      await writeFile(urls, "");
      const child = Bun.spawn([process.execPath, "--preload", preload, path.join(repo, "bin/local-tts-runner.ts"),
        "--text", "Hello", "--output", path.join(f.root, "out.wav"), "--reference", path.join(f.root, "reference.wav"),
        "--reference-text", "Synthetic reference.", "--daemon-url", `${f.url}///`,
        "--auth-token-file", path.join(f.root, "auth"), "--no-cache",
        ...(timeout === undefined ? [] : ["--timeout-ms", String(timeout)])], {
        cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect((await readFile(urls, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual([`${f.url}/synthesize`]);
      return { code, stderr, timers: (await readFile(log, "utf8")).trim().split("\n").map(Number) };
    };
    const defaultResult = await run();
    expect(defaultResult.code, defaultResult.stderr).toBe(0);
    expect(defaultResult.timers).toContain(120_000);
    const overridden = await run(1000);
    expect(overridden.code, overridden.stderr).toBe(0);
    expect(overridden.timers).toContain(1000);
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) expect(request).toMatchObject({ url: `${f.url}/synthesize` });
    f.setMode("timeout");
    const slow = await run(50);
    expect(slow.code).toBe(1);
    expect(stderrClass(slow.stderr)).toBe("The operation was aborted.");
    expect(slow.timers).toContain(50);
    expect(f.requests).toHaveLength(3);
  } finally { await f.close(); }
}, 60_000);

for (const failAt of [2, 3]) {
  test(`runner breathing timeout aborts synthesis request ${failAt}`, async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.root, "profiles.yaml"), `profiles:
  - id: synthetic-breath
    accepted: true
    renderer: voicelayer-qwen3
    render:
      reference_clip: ${f.root}/reference.wav
      reference_text: Synthetic reference.
      daemon_url: ${f.url}
      auth_token_file: ${f.root}/auth
      sentence_pause_seconds: 0.1
`);
      const preload = path.join(f.root, "breath-timers.ts");
      const log = path.join(f.root, "breath-timers.jsonl");
      await writeFile(preload, `import {appendFileSync} from 'node:fs';
const original = globalThis.setTimeout;
globalThis.setTimeout = (...args) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(args[1])+'\\n');
  return original(args[0], Math.min(args[1] ?? 0, 200), ...args.slice(2));
};`);
      f.failAt(failAt, "timeout");
      const child = Bun.spawn([process.execPath, "--preload", preload, path.join(repo, "bin/local-tts-runner.ts"),
        "--text", "First. Second.", "--output", path.join(f.root, "out.wav"),
        "--reference", "synthetic-breath", "--timeout-ms", "100", "--no-cache"], {
        cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root,
          NARRATIONLAYER_PROFILES_FILE: path.join(f.root, "profiles.yaml") }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      const result = { code, stderr };
      expect((await readFile(log, "utf8")).trim().split("\n").map(Number)).toEqual(Array(failAt).fill(100));
      expect(result.code).toBe(1);
      expect(stderrClass(result.stderr)).toBe("The operation was aborted.");
      expect(f.requests).toHaveLength(failAt);
    } finally { await f.close(); }
  }, 10_000);
}

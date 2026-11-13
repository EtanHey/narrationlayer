import { expect } from "bun:test";
import { loadProfiles } from "../../src/profiles.js";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
export const repo = path.resolve(import.meta.dir, "../..");
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export type Mode = "ok" | "http" | "malformed" | "timeout";
/** A synchronous child with a required timeout, kept below its test's budget: a test budget cannot interrupt a blocked
 * spawnSync, so the child's own timeout is what ends it. A timeout or a kill throws an error that names the command. */
export function spawnChecked(cmd: string[], options: { timeout: number; cwd?: string; env?: Record<string, string | undefined>; stdin?: Buffer }) {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", ...options, timeout: options.timeout });
  if (result.exitedDueToTimeout || result.signalCode) {
    throw new Error(`${cmd.join(" ")}: ${result.exitedDueToTimeout ? `timed out after ${options.timeout} ms` : `killed by ${result.signalCode}`}\n${result.stderr.toString()}`);
  }
  return result;
}
export async function fixture(mp3 = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nl-compat-"));
  const pcm = Buffer.alloc(4800 * 2);
  for (let i = 0; i < 4800; i++) pcm.writeInt16LE(Math.round(4000 * Math.sin(i * Math.PI / 30)), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  const wav = Buffer.concat([header, pcm]);
  await writeFile(path.join(root, "reference.wav"), wav);
  await writeFile(path.join(root, "auth"), "synthetic-token\n");
  const encoded = mp3 ? spawnChecked([tool("ffmpeg"), "-v", "error", "-i", path.join(root, "reference.wav"), "-f", "mp3", "pipe:1"], { timeout: 10000 }) : undefined;
  if (encoded && encoded.exitCode !== 0) throw new Error(encoded.stderr.toString());
  const audio = encoded?.stdout ?? wav;
  const requests: unknown[] = [];
  let mode: Mode = "ok";
  let failAt = Infinity;
  let failure: Mode = "http";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json();
    expect(request.headers.get("host")).toBe(new URL(request.url).host);
    expect(Number(request.headers.get("content-length"))).toBe(Buffer.byteLength(JSON.stringify(body)));
    requests.push({ method: request.method, url: request.url, headers: { "content-type": request.headers.get("content-type"), authorization: request.headers.get("authorization") }, body });
    const selected = requests.length >= failAt ? failure : mode;
    if (selected === "timeout") return new Promise<Response>(resolve => { const abort = () => resolve(new Response(null, { status: 499 })); if (request.signal.aborted) abort(); else request.signal.addEventListener("abort", abort, { once: true }); });
    if (selected === "http") return new Response("synthetic failure", { status: 500 });
    return Response.json(selected === "malformed" ? {} : { audio_b64: audio.toString("base64"), audio_duration_ms: 200, duration_ms: 7 });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  // Canonicalization table: fixture root -> $FIXTURE; ephemeral daemon origin -> $DAEMON;
  // created_at/updated_at wall-clock strings -> $TIME. No identity/provenance fields masked.
  const canonical = (value: unknown): unknown => {
    if (typeof value === "string") return value.replaceAll(root, "$FIXTURE").replaceAll(url, "$DAEMON");
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(created_at|updated_at)$/.test(k) ? "$TIME" : canonical(v)]));
    return value;
  };
  return { root, wav, url, requests, canonical, setMode(value: Mode) { mode = value; }, failAt(value: number, selected: Mode = "http") { failAt = value; failure = selected; }, async close() { server.stop(true); await rm(root, { recursive: true, force: true }); } };
}
export async function golden(name: string, value: unknown) {
  const file = path.join(import.meta.dir, "fixtures", `${name}.golden.json`);
  if (process.env.UPDATE_COMPAT_GOLDENS === "1") {
    if (process.env.CI) throw new Error("Golden updates are forbidden in CI");
    await writeFile(file, JSON.stringify(value, null, 2) + "\n");
    throw new Error("Goldens updated; re-run without UPDATE_COMPAT_GOLDENS to verify");
  }
  expect(value).toEqual(JSON.parse(await readFile(file, "utf8")));
}
export function tool(name: string): string {
  const found = Bun.which(name);
  if (!found) throw new Error(`Characterization requires ${name} on PATH; install it before running this test.`);
  return found;
}
export async function wrappers(root: string) {
  const dir = path.join(root, "tools");
  await mkdir(dir);
  for (const name of ["ffmpeg", "ffprobe"]) {
    const real = tool(name);
    const file = path.join(dir, name);
    await writeFile(file, `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';\nappendFileSync(process.env.COMPAT_ARGV, JSON.stringify({tool:${JSON.stringify(name)},args:process.argv.slice(2),...(process.argv.includes('concat')?{concat:readFileSync(process.argv[process.argv.indexOf('-i')+1],'utf8')}:{})})+'\\n');\nconst child=Bun.spawn([${JSON.stringify(real)},...process.argv.slice(2)],{stdin:'inherit',stdout:'inherit',stderr:'pipe'});\nconst stderr=await new Response(child.stderr).text(); process.stderr.write(stderr);\nif(process.argv.includes('volumedetect')) appendFileSync(process.env.COMPAT_ARGV+'.volume',Number(stderr.match(/mean_volume:\\s*(-?[0-9.]+)/)?.[1])+'\\n');\nprocess.exit(await child.exited);\n`);
    await chmod(file, 0o755);
  }
  return dir;
}
export async function argvLog(root: string) {
  const text = await Bun.file(path.join(root, "argv.jsonl")).text().catch(() => "");
  return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [];
}
// Preserve the executed filter structure without pinning ffmpeg's measured loudness.
export async function stableArgv(root: string) {
  const text = await Bun.file(path.join(root, "argv.jsonl.volume")).text();
  const measurements = text.trim().split("\n").map(Number);
  const calls = await argvLog(root);
  const stable = calls.map(call => ({ ...call, args: call.args.map((arg: string) => {
    const gain = arg.match(/^volume=([^d]+)dB,alimiter=limit=0.95$/);
    if (!gain) return arg;
    const measured = measurements.shift();
    expect(typeof measured).toBe("number"); expect(Number.isFinite(measured)).toBe(true);
    expect(Number(gain[1])).toBe(-20 - Number(measured));
    return "volume=$GAIN_FROM_VOLUMEDETECTdB,alimiter=limit=0.95";
  }) }));
  expect(measurements).toHaveLength(0);
  return stable;
}
export async function assertRootProfile(id: string, base = repo) {
  const previous = process.env.NARRATIONLAYER_PROFILES_FILE;
  try {
    delete process.env.NARRATIONLAYER_PROFILES_FILE;
    if ((await loadProfiles(base)).some(p => p.id === id && p.source_path === path.join(base, "profiles.local.yaml")))
      throw new Error(`Characterization fixture conflict: profiles.local.yaml overrides ${id}; use a clean worktree`);
  } finally { if (previous === undefined) delete process.env.NARRATIONLAYER_PROFILES_FILE; else process.env.NARRATIONLAYER_PROFILES_FILE = previous; }
}
export async function runner(f: Awaited<ReturnType<typeof fixture>>, args: string[], profileFile = true) {
  const child = Bun.spawn([tool("bun"), path.join(repo, "bin/local-tts-runner.ts"), ...args], {
    cwd: f.root, env: { PATH: `${path.join(f.root, "tools")}${path.delimiter}${process.env.PATH}`, HOME: f.root,
      COMPAT_ARGV: path.join(f.root, "argv.jsonl"), NARRATIONLAYER_PROFILES_FILE: profileFile ? path.join(f.root, "profiles.yaml") : undefined,
      NARRATIONLAYER_QWEN3_DAEMON_URL: "http://127.0.0.1:1", NARRATIONLAYER_QWEN3_AUTH_TOKEN_FILE: "ignored-env-token" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}
export function stderrClass(stderr: string) {
  return stderr.match(/local-tts-runner: (cache HIT|ok|daemon \/synthesize failed \(500\): synthetic failure|daemon response missing audio_b64|The operation was aborted\.(?=\r?$))/im)?.[1] ?? stderr;
}

export async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const apply = (values: typeof env) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  try { apply(env); return await run(); } finally { apply(previous); }
}

// Shared runner run configurations: the executable, defaults and output tests make the same runs.
type Fixture = Awaited<ReturnType<typeof fixture>>;
export const runnerArgs = (f: Fixture, text: string, reference = path.join(f.root, "reference.wav")) => [
  "--text", text, "--output", path.join(f.root, "out.wav"), "--reference", reference,
  "--reference-text", "Synthetic reference.", "--daemon-url", `${f.url}///`, "--auth-token-file", path.join(f.root, "auth"),
  "--cache-dir", path.join(f.root, "cache"), "--timeout-ms", "10000",
];
export async function compatProfile(f: Fixture) {
  await writeFile(path.join(f.root, "profiles.yaml"), `profiles:\n  - id: compat-voice\n    accepted: true\n    renderer: voicelayer-qwen3\n    profile_version: synthetic-v1\n    render:\n      reference_clip: ${f.root}/reference.wav\n      reference_text: Profile text.\n      daemon_url: ${f.url}\n      auth_token_file: ${f.root}/auth\n      model: synthetic-model\n      comma_pause_seconds: 0.22\n      eq_highshelf_hz: 4000\n      eq_highshelf_gain_db: 0\n      atempo: 1\n      loudness_target_db: -20\n`);
}
export const defaultsText = "First clause, second clause. Last sentence.";
export type DefaultsRender = { sentence_pause_seconds?: number; comma_pause_seconds?: number; atempo?: number };
export const defaultsCases: { name: string; render: DefaultsRender; params: Record<string, number>; sentence: number; comma: number }[] = [
  { name: "sentence-only", render: { sentence_pause_seconds: 0.41, atempo: 1 }, params: { atempo: 1, sentencePauseSeconds: 0.41 }, sentence: 0.41, comma: 0.22 },
  { name: "comma-only", render: { comma_pause_seconds: 0.17, atempo: 1 }, params: { atempo: 1, commaPauseSeconds: 0.17 }, sentence: 0.55, comma: 0.17 },
  { name: "no-tempo", render: { sentence_pause_seconds: 0.41, comma_pause_seconds: 0.17 }, params: { sentencePauseSeconds: 0.41, commaPauseSeconds: 0.17 }, sentence: 0.41, comma: 0.17 },
];
/** Writes the `compat-defaults` profile: the synthetic voice plus the given render fields. */
export async function defaultsProfile(f: Fixture, extra: DefaultsRender) {
  const render = {
    reference_clip: path.join(f.root, "reference.wav"), reference_text: "Synthetic reference.",
    daemon_url: f.url, auth_token_file: path.join(f.root, "auth"), model: "synthetic-model", ...extra,
  };
  await writeFile(path.join(f.root, "profiles.yaml"), `profiles:\n  - id: compat-defaults\n    accepted: true\n    renderer: voicelayer-qwen3\n    profile_version: synthetic-v1\n    render:\n${Object.entries(render).map(([key, value]) => `      ${key}: ${value}\n`).join("")}`);
}

/**
 * Reads a WAV file's own chunks (no ffmpeg, no PATH wrapper): its PCM format, its
 * sample count per channel and its RMS level in dBFS rounded to 0.1 dB.
 */
export async function measureWav(file: string) {
  const bytes = await readFile(file);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} is not a RIFF/WAVE file`);
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", at, at + 4), size = bytes.readUInt32LE(at + 4), body = bytes.subarray(at + 8, at + 8 + size);
    if (id === "fmt ") format = { audioFormat: body.readUInt16LE(0), channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bitsPerSample: body.readUInt16LE(14) };
    if (id === "data") data = body;
    at += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error(`${file} has no fmt or data chunk`);
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) throw new Error(`${file} is not 16-bit PCM: ${JSON.stringify(format)}`);
  const values = data.length / 2;
  let sum = 0;
  for (let i = 0; i < values; i++) sum += (data.readInt16LE(i * 2) / 32768) ** 2;
  const rmsDb = values === 0 || sum === 0 ? null : Math.round(10 * Math.log10(sum / values) * 10) / 10;
  return { format, samples: values / format.channels, rmsDb };
}

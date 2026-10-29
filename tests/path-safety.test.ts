import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import * as schema from "../src/schema.js";
import { resolveWithinRoot } from "../src/path-safety.js";
import { renderSegment as renderFake } from "../src/renderers/fake.js";
import { renderSegment as renderExternal } from "../src/renderers/external-command.js";
import { renderSegment as renderQwen } from "../src/renderers/voicelayer-qwen3.js";
import { getJob, getJobDir, getManifest, getStatus, initializeJob } from "../src/job-store.js";
import { handleMcpToolCall } from "../src/mcp-server.js";
import { parseNarrationJob } from "../src/schema.js";
import { createJobFromFile } from "../src/service.js";

const unsafeIds = ["../x", "a/../../b", "/absolute", "C:\\absolute", "..", ".", "a\0b", "a\\b", "a".repeat(129), "a\n", "a\r", "a\u2028", "%2e%2e%2fx", " safe ", "", 42, null];
const payload = { voice_profile: "neutral-reader", renderer: "fake", segments: [{ id: "intro", title: "Intro", script: "Hello world." }] };

test("unsafe job and segment IDs are rejected at parsing, MCP creation and JSON import", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nl-path-intake-"));
  try {
    for (const id of unsafeIds) {
      for (const job of [{ ...payload, job_id: id }, { ...payload, segments: [{ ...payload.segments[0], id }] }]) {
        expect(() => parseNarrationJob(job)).toThrow(/Invalid .*id/);
        await expect(handleMcpToolCall("create_narration_job", { job })).rejects.toThrow(/Invalid .*id/);
        const input = path.join(dataDir, "input.json");
        await writeFile(input, JSON.stringify(job));
        await expect(createJobFromFile(input, dataDir)).rejects.toThrow(/Invalid .*id/);
        await expect(handleMcpToolCall("create_narration_job", { job_path: input })).rejects.toThrow(/Invalid .*id/);
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("unsafe lookup IDs fail before store access and MCP dispatch", async () => {
  for (const id of unsafeIds.filter((id): id is string => typeof id === "string")) {
    expect(() => getJobDir(id)).toThrow(/Invalid job_id/);
    for (const lookup of [getJob, getStatus, getManifest]) {
      await expect(lookup(id)).rejects.toThrow(/Invalid job_id/);
    }
    for (const tool of ["render_narration_job", "get_narration_status", "get_narration_result"]) {
      await expect(handleMcpToolCall(tool, { job_id: id })).rejects.toThrow(/Invalid job_id/);
    }
  }
});

test("CLI create-job rejects unsafe job and segment IDs without writing jobs", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nl-path-cli-"));
  try {
    for (const id of unsafeIds) {
      for (const job of [{ ...payload, job_id: id }, { ...payload, segments: [{ ...payload.segments[0], id }] }]) {
        const input = path.join(dataDir, "input.json");
        await writeFile(input, JSON.stringify(job));
        const proc = Bun.spawn([process.execPath, "run", "narrationlayer", "create-job", input], {
          env: { ...process.env, NARRATIONLAYER_DATA_DIR: dataDir }, stdout: "pipe", stderr: "pipe",
        });
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
        expect(code).not.toBe(0);
        expect(stderr).toMatch(/Invalid .*id/);
      }
    }
    expect(await readdir(dataDir)).toEqual(["input.json"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("CLI lookups reject unsafe IDs", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nl-path-cli-lookup-"));
  try {
    // NUL cannot be represented in an OS argv; it is covered at JSON/MCP/store boundaries above.
    for (const id of unsafeIds.filter((id): id is string => typeof id === "string" && !id.includes("\0"))) {
      const proc = Bun.spawn([process.execPath, "run", "narrationlayer", "status", id], {
        env: { ...process.env, NARRATIONLAYER_DATA_DIR: dataDir }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(id === "" ? /status requires <job-id>/ : /Invalid job_id/);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("UUIDs, fixture IDs and omitted defaults remain usable on disk", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nl-path-valid-"));
  try {
    const generated = parseNarrationJob({ ...payload, segments: [{ title: "Intro", script: "Hello." }] });
    expect(generated.job_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(generated.segments[0].id).toBe("segment-1");
    for (const id of [generated.job_id, "sample-job", "A.b_c-9", "x", "a".repeat(128)]) {
      const job = { ...generated, job_id: id };
      await initializeJob(job, dataDir);
      expect(await getJob(id, dataDir)).toEqual(job);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("persisted job JSON is validated before rendering", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nl-path-persisted-"));
  try {
    const jobDir = getJobDir("persisted", dataDir);
    await mkdir(jobDir, { recursive: true });
    for (const job of [{ ...payload, job_id: "../x" }, { ...payload, job_id: "persisted", segments: [{ ...payload.segments[0], id: "../../x" }] }]) {
      await writeFile(path.join(jobDir, "job.json"), JSON.stringify(job));
      await expect(getJob("persisted", dataDir)).rejects.toThrow(/Invalid .*id/);
    }
    expect(await readFile(path.join(jobDir, "job.json"), "utf8")).toContain("../../x");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("destination guard rejects escapes, absolute paths and sibling-prefix collisions", () => {
  const root = path.join(os.tmpdir(), "nl-artifacts");
  for (const parts of [["segments", "../../../outside"], ["../nl-artifacts-sibling/file"], ["/outside"], ["."]]) {
    expect(() => resolveWithinRoot(root, ...parts)).toThrow(/Path escapes root/);
  }
  expect(resolveWithinRoot(root, "segments", "intro", "intro.mp3")).toBe(path.resolve(root, "segments/intro/intro.mp3"));
});

test("store confinement rejects traversal even when identifier validation is bypassed", () => {
  const validator = spyOn(schema, "parsePathId").mockImplementation((value) => String(value));
  try {
    expect(() => getJobDir("../outside", os.tmpdir())).toThrow(/Path escapes root/);
  } finally {
    validator.mockRestore();
  }
});

test("all renderers confine destinations for IDs that bypassed parsing", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nl-path-renderer-"));
  try {
    const job = parseNarrationJob(payload);
    const segment = job.segments[0];
    // Keep even the guard-removal mutants' repeated traversal inside this disposable directory.
    const options = { dataDir, artifactsDir: path.join(dataDir, "sandbox", "one", "two", "three", "artifacts"), fetch: async () => { throw new Error("Unexpected synthesis request"); } };
    for (const id of ["../../../outside", path.join(dataDir, "outside")]) {
      await expect(renderFake(id, segment, job, options)).rejects.toThrow(/Path escapes root/);
      await expect(renderExternal(id, segment, options, { command: process.execPath, args: ["-e", "process.exit(0)"] })).rejects.toThrow(/Path escapes root/);
      await expect(renderQwen(id, segment, options, { auth_token: "test-token", reference_clip: "/unused.wav", reference_text: "Hello." })).rejects.toThrow(/Path escapes root/);
    }
    expect(await Bun.file(path.join(dataDir, "outside", "words.json")).exists()).toBe(false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("renderer leaf guards reject IDs whose second application climbs out of the artifacts root", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nl-path-leaf-"));
  try {
    const job = parseNarrationJob(payload);
    const segment = job.segments[0];
    const artifactsDir = path.join(dataDir, "sandbox", "one", "two", "three", "artifacts");
    const options = { dataDir, artifactsDir, fetch: async () => { throw new Error("Unexpected synthesis request"); } };
    // segments/<id> resolves inside to artifacts/r1/r2, but <id>.mp3 from there resolves outside to three/three/artifacts/r1/r2.mp3.
    const id = "../../../three/artifacts/r1/r2";
    expect(resolveWithinRoot(artifactsDir, "segments", id)).toBe(path.join(artifactsDir, "r1", "r2"));
    await expect(renderFake(id, segment, job, options)).rejects.toThrow(/Path escapes root/);
    await expect(renderExternal(id, segment, options, { command: process.execPath, args: ["-e", "process.exit(0)"] })).rejects.toThrow(/Path escapes root/);
    await expect(renderQwen(id, segment, options, { auth_token: "test-token", reference_clip: "/unused.wav", reference_text: "Hello." })).rejects.toThrow(/Path escapes root/);
    expect(await Bun.file(path.join(dataDir, "sandbox", "one", "two", "three", "three", "artifacts", "r1", "r2.mp3")).exists()).toBe(false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

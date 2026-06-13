import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { expect, test } from "bun:test";

function repoRoot(): string {
  return process.cwd();
}

function createTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "narrationlayer-"));
}

function parseJobId(output: string): string {
  const match = output.match(/Job ID:\s*([A-Za-z0-9._-]+)/i);
  if (!match) {
    throw new Error("Could not parse job id from output");
  }
  return match[1];
}

async function runNarrationLayer(args: string[], dataDir: string): Promise<string> {
  const proc = Bun.spawn(["bun", "run", "narrationlayer", ...args], {
    cwd: repoRoot(),
    env: {
      ...process.env,
      NARRATIONLAYER_DATA_DIR: dataDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${stderr || stdout}`);
  }
  return stdout;
}

test("create-job, render, status, and manifest end-to-end", async () => {
  const dataDir = createTempDir();

  try {
    const jobJsonPath = path.join(dataDir, "sample-job.json");
    const jobPayload = JSON.stringify(
      {
        voice_profile: "neutral-reader",
        renderer: "fake",
        segments: [
          {
            id: "seg-1",
            title: "Introduction",
            script: "NarrationLayer keeps narration jobs explicit and auditable.",
          },
          {
            id: "seg-2",
            title: "Fallback",
            script: "Segment-level manifests support teleprompter timing output.",
          },
        ],
      },
      null,
      2,
    );

    await Bun.write(Bun.file(jobJsonPath), jobPayload);

    const createOut = await runNarrationLayer(["create-job", jobJsonPath], dataDir);
    const jobId = parseJobId(createOut);
    const createdManifestPath = path.join(dataDir, "jobs", jobId, "manifest.json");
    const createdManifestRaw = await Bun.file(createdManifestPath).text();
    const createdManifest = JSON.parse(createdManifestRaw);

    expect(createdManifest.job_id).toBe(jobId);
    expect(createdManifest.renderer).toBe("fake");
    expect(createdManifest.segments).toHaveLength(2);

    await runNarrationLayer(["render", jobId], dataDir);
    const statusOut = await runNarrationLayer(["status", jobId], dataDir);
    const status = JSON.parse(statusOut);
    expect(status.status).toBe("done");
    expect(status.done).toBeTrue();

    const manifest = JSON.parse(await Bun.file(createdManifestPath).text());
    expect(manifest.segments).toHaveLength(2);
    expect(manifest.segments[0]).toMatchObject({
      id: "seg-1",
      status: "rendered",
      words_path: expect.any(String),
      audio_path: expect.any(String),
    });
    expect(Boolean(manifest.segments[0].audio_path)).toBeTrue();
    expect(Boolean(manifest.segments[0].words_path)).toBeTrue();
    expect(manifest.segments[0].status).toBe("rendered");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("doctor prints resolved data directory", async () => {
  const dataDir = createTempDir();
  try {
    const out = await runNarrationLayer(["doctor"], dataDir);
    expect(out).toContain("NarrationLayer v1");
    expect(out).toContain(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("qwen3-lora-prepare writes raw JSONL from a local metadata config", async () => {
  const dataDir = createTempDir();
  const clipsDir = path.join(dataDir, "clips");
  const outputDir = path.join(dataDir, "qwen3-lora");
  try {
    await Bun.$`mkdir -p ${clipsDir}`.quiet();
    await Bun.write(path.join(clipsDir, "clip.wav"), "fake wav");
    await Bun.write(path.join(dataDir, "ref.wav"), "fake ref");
    await Bun.write(
      path.join(dataDir, "metadata_train.csv"),
      "audio_file|text|speaker_name\nclip.wav|CLI transcript.|THEO\n",
    );
    const configPath = path.join(dataDir, "qwen3-lora.json");
    await Bun.write(
      configPath,
      JSON.stringify(
        {
          train_metadata_csv: path.join(dataDir, "metadata_train.csv"),
          clips_dir: clipsDir,
          ref_audio: path.join(dataDir, "ref.wav"),
          output_dir: outputDir,
          speaker_name: "theo_lora",
        },
        null,
        2,
      ),
    );

    const out = await runNarrationLayer(["qwen3-lora-prepare", configPath, "--json"], dataDir);
    const result = JSON.parse(out);
    expect(result.train_count).toBe(1);
    expect(result.train_raw_jsonl).toBe(path.join(outputDir, "train_raw.jsonl"));
    expect(await Bun.file(result.train_raw_jsonl).text()).toContain("CLI transcript.");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("qwen3-lora-preflight reports prepared run readiness", async () => {
  const dataDir = createTempDir();
  const clipsDir = path.join(dataDir, "clips");
  const outputDir = path.join(dataDir, "qwen3-lora");
  try {
    await Bun.$`mkdir -p ${clipsDir}`.quiet();
    await Bun.write(path.join(clipsDir, "clip.wav"), "fake wav");
    await Bun.write(path.join(dataDir, "ref.wav"), "fake ref");
    await Bun.write(
      path.join(dataDir, "metadata_train.csv"),
      "audio_file|text|speaker_name\nclip.wav|CLI transcript.|THEO\n",
    );
    const configPath = path.join(dataDir, "qwen3-lora.json");
    await Bun.write(
      configPath,
      JSON.stringify(
        {
          train_metadata_csv: path.join(dataDir, "metadata_train.csv"),
          clips_dir: clipsDir,
          ref_audio: path.join(dataDir, "ref.wav"),
          output_dir: outputDir,
        },
        null,
        2,
      ),
    );

    await runNarrationLayer(["qwen3-lora-prepare", configPath, "--json"], dataDir);
    const out = await runNarrationLayer(["qwen3-lora-preflight", outputDir, "--json"], dataDir);
    const result = JSON.parse(out);
    expect(result.ready).toBeFalse();
    expect(result.counts.train_raw_rows).toBe(1);
    expect(result.checks.some((check: { id: string }) => check.id === "runtime.python")).toBeTrue();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

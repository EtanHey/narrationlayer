#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

import {
  getDataDir,
  getJob,
  getManifest,
  getStatus,
  getAllJobIds,
  initializeJob,
  pathsForJob,
  writeManifest,
  writeStatus,
  markDone,
  markFailed,
  fileExists,
} from "./job-store.js";
import { parseNarrationJob, type RenderManifest, type RenderManifestSegment, type JobStatus } from "./schema.js";
import { renderSegment as renderFakeSegment } from "./renderers/fake.js";
import { renderSegment as renderQwenSegment, type VoiceLayerQwen3Config } from "./renderers/voicelayer-qwen3.js";

const HELP = `NarrationLayer CLI

Usage:
  narrationlayer doctor
  narrationlayer create-job <job.json>
  narrationlayer render <job-id>
  narrationlayer status <job-id>
  narrationlayer watch <job-id>

The command also supports ` + "`--help`" + ` to show this message.
`;

function renderIdBanner(jobId: string): void {
  console.log(`Job ID: ${jobId}`);
}

async function cmdDoctor() {
  const dataDir = getDataDir();
  const jobsDir = path.join(dataDir, "jobs");
  console.log("NarrationLayer v0");
  console.log(`Data directory: ${dataDir}`);
  console.log(`Jobs directory: ${jobsDir}`);
  console.log(`Renderer env default: ${process.env.NARRATIONLAYER_DEFAULT_RENDERER || "fake"}`);
}

async function cmdCreateJob(jobFilePath?: string): Promise<string> {
  if (!jobFilePath) {
    throw new Error("create-job requires <job.json>");
  }

  const payloadRaw = await readFile(jobFilePath, "utf8");
  const payload = parseNarrationJob(JSON.parse(payloadRaw));
  const { job, paths } = await initializeJob(payload);
  renderIdBanner(job.job_id);
  console.log(`Stored job manifest at: ${paths.jobPath}`);
  console.log(`Stored render manifest at: ${paths.manifestPath}`);
  return job.job_id;
}

function getRendererConfig(): { qwen: VoiceLayerQwen3Config } {
  const referenceClip = process.env.NARRATIONLAYER_QWEN3_REFERENCE_CLIP;
  const referenceTextPath = process.env.NARRATIONLAYER_QWEN3_REFERENCE_TEXT_PATH;
  const referenceClips = process.env.NARRATIONLAYER_QWEN3_REFERENCE_CLIPS;
  const referenceClipList = referenceClips ? referenceClips.split(",").map((item) => item.trim()).filter(Boolean) : [];
  return {
    qwen: {
      reference_clip: referenceClip,
      reference_text_path: referenceTextPath,
      reference_clips: referenceClipList,
    },
  };
}

async function cmdRender(jobId?: string): Promise<RenderManifest> {
  if (!jobId) {
    throw new Error("render requires <job-id>");
  }

  const job = await getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const paths = pathsForJob(jobId);
  const config = getRendererConfig();
  const startTime = new Date().toISOString();
  const manifest: RenderManifest = {
    job_id: job.job_id,
    created_at: startTime,
    voice_profile: job.voice_profile,
    renderer: job.renderer,
    segments: [],
    total_duration_seconds: 0,
    artifacts_dir: path.join(paths.jobDir, "artifacts"),
    errors: [],
  };

  let status: JobStatus = {
    job_id: job.job_id,
    status: "rendering",
    created_at: job.created_at,
    updated_at: new Date().toISOString(),
    progress: { completed_segments: 0, total_segments: job.segments.length },
    errors: [],
  };
  await writeStatus(jobId, status);

  for (let index = 0; index < job.segments.length; index += 1) {
    const segment = job.segments[index];
    status = {
      ...status,
      current_step: `rendering segment ${segment.id}`,
      progress: {
        completed_segments: index,
        total_segments: job.segments.length,
      },
      updated_at: new Date().toISOString(),
    };
    await writeStatus(jobId, status);

    try {
      let result: RenderManifestSegment;
      if (job.renderer === "fake") {
        result = await renderFakeSegment(
          segment.id,
          segment,
          job,
          {
            artifactsDir: manifest.artifacts_dir,
            dataDir: getDataDir(),
          },
        );
      } else {
        result = await renderQwenSegment(segment.id, segment, getDataDir(), config.qwen);
      }
      manifest.segments.push(result);
      manifest.total_duration_seconds += result.duration_seconds;
      status.progress.completed_segments = index + 1;
      await writeManifest(jobId, manifest);
      await writeStatus(jobId, {
        ...status,
        updated_at: new Date().toISOString(),
        errors: status.errors,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      manifest.errors.push(message);
      manifest.segments.push({
        id: segment.id,
        title: segment.title,
        script: segment.script,
        audio_path: "",
        duration_seconds: segment.duration_seconds ?? 0,
        words_path: "",
        status: "failed",
      });
      status.progress.completed_segments = index + 1;
      status.errors.push(message);
      await writeManifest(jobId, manifest);
      await writeStatus(jobId, {
        ...status,
        status: "failed",
        updated_at: new Date().toISOString(),
        errors: [...status.errors],
      });
      await markFailed(jobId);
      throw error;
    }
  }

  manifest.segments = manifest.segments.map((segment) => ({ ...segment, status: "rendered" }));
  await writeManifest(jobId, manifest);
  const finished: JobStatus = {
    ...status,
    status: "done",
    updated_at: new Date().toISOString(),
    progress: {
      completed_segments: job.segments.length,
      total_segments: job.segments.length,
    },
    current_step: "complete",
    errors: manifest.errors,
  };
  await writeStatus(jobId, finished);
  await markDone(jobId);
  return manifest;
}

async function cmdStatus(jobId?: string) {
  if (!jobId) {
    throw new Error("status requires <job-id>");
  }
  const status = await getStatus(jobId);
  if (!status) {
    throw new Error(`Status not found for job: ${jobId}`);
  }
  const paths = pathsForJob(jobId);
  const done = await fileExists(paths.donePath);
  const failed = await fileExists(paths.failedPath);
  const summary = {
    ...status,
    done,
    failed,
    manifest: await getManifest(jobId),
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function cmdWatch(jobId?: string) {
  if (!jobId) {
    throw new Error("watch requires <job-id>");
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await getStatus(jobId);
    if (!status) {
      throw new Error(`Status not found for job: ${jobId}`);
    }
    console.log(`${status.status} (${status.progress.completed_segments}/${status.progress.total_segments})`);
    if (status.status === "done" || status.status === "failed") {
      return;
    }
    await sleep(700);
  }
  throw new Error("watch timed out");
}

async function cmdListJobs() {
  const ids = await getAllJobIds();
  console.log(JSON.stringify(ids));
}

export async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  const payload = args[1];
  switch (command) {
    case "doctor":
      await cmdDoctor();
      break;
    case "create-job":
      await cmdCreateJob(payload);
      break;
    case "render":
      await cmdRender(payload);
      break;
    case "status":
      await cmdStatus(payload);
      break;
    case "watch":
      await cmdWatch(payload);
      break;
    case "list-jobs":
      await cmdListJobs();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

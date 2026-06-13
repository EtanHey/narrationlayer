import { mkdir, readFile, writeFile, readdir, access, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { type RenderManifest, type JobStatus, type NormalizedNarrationJob } from "./schema.js";

export interface JobPaths {
  jobDir: string;
  jobPath: string;
  statusPath: string;
  manifestPath: string;
  donePath: string;
  failedPath: string;
}

export interface JobStoreRecord {
  job: NormalizedNarrationJob;
  paths: JobPaths;
}

const JOB_MARKER_DONE = "DONE";
const JOB_MARKER_FAILED = "FAILED";

function expandHome(value: string): string {
  if (!value) {
    return value;
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function getDataDir(): string {
  const envDir = process.env.NARRATIONLAYER_DATA_DIR;
  return path.resolve(expandHome(envDir || path.join(os.homedir(), ".narrationlayer")));
}

export function getJobDir(jobId: string, dataDir = getDataDir()): string {
  if (!jobId || jobId.trim().length < 2) {
    throw new Error("jobId is required");
  }
  return path.join(dataDir, "jobs", jobId);
}

export async function ensureDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export function pathsForJob(jobId: string, dataDir = getDataDir()): JobPaths {
  const jobDir = getJobDir(jobId, dataDir);
  return {
    jobDir,
    jobPath: path.join(jobDir, "job.json"),
    statusPath: path.join(jobDir, "status.json"),
    manifestPath: path.join(jobDir, "manifest.json"),
    donePath: path.join(jobDir, JOB_MARKER_DONE),
    failedPath: path.join(jobDir, JOB_MARKER_FAILED),
  };
}

export async function readJobJson<T>(jobPath: string): Promise<T> {
  const data = await readFile(jobPath, "utf8");
  return JSON.parse(data) as T;
}

export async function writeJobJson<T>(pathName: string, data: T): Promise<void> {
  const tempPath = `${pathName}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempPath, pathName);
}

export async function fileExists(pathName: string): Promise<boolean> {
  try {
    await access(pathName, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function initializeJob(job: NormalizedNarrationJob, dataDir = getDataDir()): Promise<JobStoreRecord> {
  const paths = pathsForJob(job.job_id, dataDir);
  const artifactsDir = path.join(paths.jobDir, "artifacts");
  const initialManifest: RenderManifest = {
    job_id: job.job_id,
    created_at: job.created_at,
    voice_profile: job.voice_profile,
    renderer: job.renderer,
    segments: job.segments.map((segment) => ({
      id: segment.id,
      title: segment.title,
      script: segment.script,
      audio_path: "",
      duration_seconds: segment.duration_seconds ?? 0,
      words_path: "",
      status: "pending",
    })),
    total_duration_seconds: job.segments.reduce((sum, segment) => sum + (segment.duration_seconds ?? 0), 0),
    artifacts_dir: artifactsDir,
    errors: [],
  };
  const initialStatus: JobStatus = {
    job_id: job.job_id,
    status: "queued",
    created_at: job.created_at,
    updated_at: new Date().toISOString(),
    progress: {
      completed_segments: 0,
      total_segments: job.segments.length,
    },
    errors: [],
  };

  await ensureDirectory(paths.jobDir);
  await ensureDirectory(artifactsDir);
  await rm(paths.donePath, { force: true });
  await rm(paths.failedPath, { force: true });
  await writeJobJson(paths.jobPath, job);
  await writeJobJson(paths.manifestPath, initialManifest);
  await writeJobJson(paths.statusPath, initialStatus);
  return { job, paths };
}

export async function getStatus(jobId: string, dataDir = getDataDir()): Promise<JobStatus | null> {
  const paths = pathsForJob(jobId, dataDir);
  if (!(await fileExists(paths.statusPath))) {
    return null;
  }
  return readJobJson<JobStatus>(paths.statusPath);
}

export async function getManifest(jobId: string, dataDir = getDataDir()): Promise<RenderManifest | null> {
  const paths = pathsForJob(jobId, dataDir);
  if (!(await fileExists(paths.manifestPath))) {
    return null;
  }
  return readJobJson<RenderManifest>(paths.manifestPath);
}

export async function getJob(jobId: string, dataDir = getDataDir()): Promise<NormalizedNarrationJob | null> {
  const paths = pathsForJob(jobId, dataDir);
  if (!(await fileExists(paths.jobPath))) {
    return null;
  }
  return readJobJson<NormalizedNarrationJob>(paths.jobPath);
}

export async function getAllJobIds(dataDir = getDataDir()): Promise<string[]> {
  const root = path.join(dataDir, "jobs");
  try {
    await access(root, constants.F_OK);
  } catch {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function writeStatus(jobId: string, status: JobStatus, dataDir = getDataDir()): Promise<void> {
  const paths = pathsForJob(jobId, dataDir);
  await writeJobJson(paths.statusPath, status);
}

export async function writeManifest(jobId: string, manifest: RenderManifest, dataDir = getDataDir()): Promise<void> {
  const paths = pathsForJob(jobId, dataDir);
  await writeJobJson(paths.manifestPath, manifest);
}

export async function markDone(jobId: string, dataDir = getDataDir()): Promise<void> {
  const paths = pathsForJob(jobId, dataDir);
  await rm(paths.failedPath, { force: true });
  await writeFile(paths.donePath, "done");
}

export async function markFailed(jobId: string, dataDir = getDataDir()): Promise<void> {
  const paths = pathsForJob(jobId, dataDir);
  await rm(paths.donePath, { force: true });
  await writeFile(paths.failedPath, "failed");
}

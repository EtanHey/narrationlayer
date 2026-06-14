#!/usr/bin/env bun

import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { getDataDir, getStatus } from "./job-store.js";
import { createBakeoffJobsFromFile } from "./bakeoff.js";
import { createDashboardDemo } from "./dashboard.js";
import {
  preflightQwen3LoraRun,
  prepareQwen3LoraDatasetFromFile,
} from "./qwen3-lora.js";
import {
  createJobFromFile,
  getDoctorSummary,
  getJobResult,
  getStatusSummary,
  listJobIds,
  renderJob,
} from "./service.js";

const HELP =
  `NarrationLayer CLI

Usage:
  narrationlayer doctor
  narrationlayer create-job <job.json> [--json]
  narrationlayer render <job-id> [--json]
  narrationlayer status <job-id>
  narrationlayer result <job-id>
  narrationlayer dashboard <job-id> [--open] [--audio-base-url <url>]
  narrationlayer bakeoff-create <bakeoff.json> [--json]
  narrationlayer qwen3-lora-prepare <config.json> [--json]
  narrationlayer qwen3-lora-preflight <run-dir> [--json]
  narrationlayer list-jobs
  narrationlayer watch <job-id>

All persistent state is under NARRATIONLAYER_DATA_DIR or ~/.narrationlayer.
The command also supports ` +
  "`--help`" +
  ` to show this message.
`;

function renderIdBanner(jobId: string): void {
  console.log(`Job ID: ${jobId}`);
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flagValue(args: string[], flag: string): string | undefined {
  const eq = args.find((arg) => arg.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

async function cmdDoctor(json = false) {
  const payload = await getDoctorSummary();
  if (json) {
    printJson(payload);
    return;
  }
  console.log("NarrationLayer v1");
  console.log(`Data directory: ${payload.data_dir}`);
  console.log(`Jobs directory: ${payload.jobs_dir}`);
  console.log(`Renderer env default: ${payload.default_renderer}`);
  console.log(`Profile files: ${payload.profiles.files.length}`);
  console.log(`Profiles: ${payload.profiles.profiles.length}`);
}

async function cmdCreateJob(
  jobFilePath?: string,
  json = false,
): Promise<string> {
  if (!jobFilePath) {
    throw new Error("create-job requires <job.json>");
  }

  const created = await createJobFromFile(jobFilePath);
  if (json) {
    printJson(created);
  } else {
    renderIdBanner(created.job_id);
    console.log(`Stored job manifest at: ${created.job_path}`);
    console.log(`Stored render manifest at: ${created.manifest_path}`);
  }
  return created.job_id;
}

async function cmdRender(jobId?: string, json = false) {
  if (!jobId) {
    throw new Error("render requires <job-id>");
  }
  const result = await renderJob(jobId, getDataDir());
  if (json) {
    printJson(result);
  } else {
    console.log(`Rendered job: ${jobId}`);
    console.log(`Status: ${result.status.status}`);
    console.log(`Manifest: ${result.manifest.job_id}`);
  }
  return result.manifest;
}

async function cmdStatus(jobId?: string) {
  if (!jobId) {
    throw new Error("status requires <job-id>");
  }
  const summary = await getStatusSummary(jobId);
  printJson({
    ...summary.status,
    done: summary.done,
    failed: summary.failed,
    manifest_exists: summary.manifest_exists,
    manifest: summary.manifest,
  });
}

async function cmdResult(jobId?: string) {
  if (!jobId) {
    throw new Error("result requires <job-id>");
  }
  printJson(await getJobResult(jobId));
}

async function cmdDashboard(
  jobId: string | undefined,
  open = false,
  audioBaseUrl?: string,
) {
  if (!jobId) {
    throw new Error("dashboard requires <job-id>");
  }
  const outputPath = await createDashboardDemo(jobId, undefined, {
    audioBaseUrl,
  });
  if (open) {
    spawn("open", [outputPath], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  printJson({
    dashboard_path: outputPath,
    dashboard_url: pathToFileURL(outputPath).href,
  });
}

async function cmdBakeoffCreate(
  specFilePath: string | undefined,
  json = false,
) {
  if (!specFilePath) {
    throw new Error("bakeoff-create requires <bakeoff.json>");
  }
  const result = await createBakeoffJobsFromFile(specFilePath, getDataDir());
  if (json) {
    printJson(result);
    return;
  }
  console.log(`Bakeoff ID: ${result.bakeoff_id}`);
  for (const created of result.created_jobs) {
    console.log(`${created.candidate_id}: ${created.job_id}`);
  }
}

async function cmdQwen3LoraPrepare(
  configFilePath: string | undefined,
  json = false,
) {
  if (!configFilePath) {
    throw new Error("qwen3-lora-prepare requires <config.json>");
  }
  const result = await prepareQwen3LoraDatasetFromFile(configFilePath);
  if (json) {
    printJson(result);
    return;
  }
  console.log(`Qwen3 LoRA dataset: ${result.output_dir}`);
  console.log(`Train rows: ${result.train_count}`);
  console.log(`Eval rows: ${result.eval_count}`);
  console.log(`Skipped rows: ${result.skipped.length}`);
  console.log(`Train raw JSONL: ${result.train_raw_jsonl}`);
  console.log(`Eval raw JSONL: ${result.eval_raw_jsonl}`);
  console.log(`Env: ${result.env_path}`);
  console.log(`Prepare script: ${result.prepare_script_path}`);
  console.log(`Train script: ${result.train_script_path}`);
}

async function cmdQwen3LoraPreflight(runDir: string | undefined, json = false) {
  if (!runDir) {
    throw new Error("qwen3-lora-preflight requires <run-dir>");
  }
  const result = await preflightQwen3LoraRun({ run_dir: runDir });
  if (json) {
    printJson(result);
    return;
  }
  console.log(`Qwen3 LoRA preflight: ${result.ready ? "ready" : "blocked"}`);
  console.log(`Run directory: ${result.run_dir}`);
  console.log(`Train raw rows: ${result.counts.train_raw_rows}`);
  console.log(`Eval raw rows: ${result.counts.eval_raw_rows}`);
  console.log(`Missing audio rows: ${result.counts.missing_audio_rows}`);
  console.log(
    `Wrong sample-rate files: ${result.counts.sample_rate_mismatch_files}`,
  );
  console.log(
    `Unknown sample-rate files: ${result.counts.sample_rate_unknown_files}`,
  );
  for (const blocker of result.blockers) {
    console.log(`Blocker: ${blocker}`);
  }
  for (const warning of result.warnings) {
    console.log(`Warning: ${warning}`);
  }
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
    console.log(
      `${status.status} (${status.progress.completed_segments}/${status.progress.total_segments})`,
    );
    if (status.status === "done" || status.status === "failed") {
      return;
    }
    await sleep(700);
  }
  throw new Error("watch timed out");
}

async function cmdListJobs() {
  printJson({ jobs: await listJobIds() });
}

export async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  const payload = args[1];
  const json = hasFlag(args, "--json");
  const open = hasFlag(args, "--open");
  switch (command) {
    case "doctor":
      await cmdDoctor(json);
      break;
    case "create-job":
      await cmdCreateJob(payload, json);
      break;
    case "render":
      await cmdRender(payload, json);
      break;
    case "status":
      await cmdStatus(payload);
      break;
    case "result":
      await cmdResult(payload);
      break;
    case "dashboard":
      await cmdDashboard(
        payload,
        open,
        flagValue(args, "--audio-base-url") ??
          process.env.NARRATIONLAYER_AUDIO_BASE_URL,
      );
      break;
    case "bakeoff-create":
      await cmdBakeoffCreate(payload, json);
      break;
    case "qwen3-lora-prepare":
      await cmdQwen3LoraPrepare(payload, json);
      break;
    case "qwen3-lora-preflight":
      await cmdQwen3LoraPreflight(payload, json);
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

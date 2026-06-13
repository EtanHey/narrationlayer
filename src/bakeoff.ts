import { readFile } from "node:fs/promises";

import { createJobFromPayload, type CreatedJobResult } from "./service.js";
import { type NarrationSegmentInput, type RendererName } from "./schema.js";

export interface BakeoffCandidateInput {
  id: string;
  voice_profile: string;
  renderer?: RendererName;
  notes?: string;
}

export interface BakeoffSpecInput {
  bakeoff_id?: string;
  description?: string;
  candidates: BakeoffCandidateInput[];
  segments: NarrationSegmentInput[];
}

export interface BakeoffJobPlan {
  candidate_id: string;
  job: {
    job_id: string;
    voice_profile: string;
    renderer?: RendererName;
    segments: NarrationSegmentInput[];
  };
}

export interface BakeoffPlan {
  bakeoff_id: string;
  description?: string;
  jobs: BakeoffJobPlan[];
}

export interface BakeoffCreatedJob extends CreatedJobResult {
  candidate_id: string;
}

export interface BakeoffCreateResult {
  bakeoff_id: string;
  created_jobs: BakeoffCreatedJob[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRenderer(value: unknown): value is RendererName {
  return value === "fake" || value === "voicelayer-qwen3" || value === "external-command";
}

function stableId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "bakeoff";
}

function parseCandidates(raw: unknown): BakeoffCandidateInput[] {
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new Error("bakeoff candidates must be a non-empty array");
  }
  return raw.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`candidates[${index}] must be an object`);
    }
    const id = nonEmptyString(item.id);
    const voiceProfile = nonEmptyString(item.voice_profile);
    if (!id || !voiceProfile) {
      throw new Error(`candidates[${index}] requires id and voice_profile`);
    }
    const renderer = item.renderer === undefined ? undefined : isRenderer(item.renderer) ? item.renderer : undefined;
    if (item.renderer !== undefined && renderer === undefined) {
      throw new Error(`candidates[${index}].renderer is not supported`);
    }
    return {
      id: stableId(id),
      voice_profile: voiceProfile,
      ...(renderer === undefined ? {} : { renderer }),
      ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
    };
  });
}

function parseSegments(raw: unknown): NarrationSegmentInput[] {
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new Error("bakeoff segments must be a non-empty array");
  }
  return raw.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`segments[${index}] must be an object`);
    }
    const title = nonEmptyString(item.title);
    const script = nonEmptyString(item.script);
    if (!title || !script) {
      throw new Error(`segments[${index}] requires title and script`);
    }
    return {
      ...(nonEmptyString(item.id) ? { id: nonEmptyString(item.id) } : {}),
      title,
      script,
      ...(typeof item.duration_seconds === "number" && Number.isFinite(item.duration_seconds) && item.duration_seconds > 0
        ? { duration_seconds: item.duration_seconds }
        : {}),
      ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
    };
  });
}

export function parseBakeoffSpec(raw: unknown): BakeoffPlan {
  if (!isObject(raw)) {
    throw new Error("bakeoff spec must be an object");
  }
  const bakeoffId = stableId(nonEmptyString(raw.bakeoff_id) || `bakeoff-${new Date().toISOString().slice(0, 10)}`);
  const candidates = parseCandidates(raw.candidates);
  const segments = parseSegments(raw.segments);
  return {
    bakeoff_id: bakeoffId,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    jobs: candidates.map((candidate) => ({
      candidate_id: candidate.id,
      job: {
        job_id: `${bakeoffId}-${candidate.id}`,
        voice_profile: candidate.voice_profile,
        ...(candidate.renderer === undefined ? {} : { renderer: candidate.renderer }),
        segments,
      },
    })),
  };
}

export async function createBakeoffJobsFromFile(specPath: string, dataDir?: string): Promise<BakeoffCreateResult> {
  const raw = JSON.parse(await readFile(specPath, "utf8")) as unknown;
  const plan = parseBakeoffSpec(raw);
  const created_jobs: BakeoffCreatedJob[] = [];
  for (const planned of plan.jobs) {
    const created = await createJobFromPayload(planned.job, dataDir);
    created_jobs.push({
      candidate_id: planned.candidate_id,
      ...created,
    });
  }
  return {
    bakeoff_id: plan.bakeoff_id,
    created_jobs,
  };
}

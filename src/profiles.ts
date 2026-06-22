import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import type { RendererName } from "./schema.js";
import type { ExternalCommandConfig } from "./renderers/external-command.js";
import type { VoiceLayerQwen3Config } from "./renderers/voicelayer-qwen3.js";

export interface NarrationProfile {
  id: string;
  name?: string;
  renderer?: RendererName;
  voice_profile_id?: string;
  render: Record<string, string | string[]>;
  source_path?: string;
}

export interface ProfileSummary {
  files: string[];
  profiles: Array<{
    id: string;
    renderer?: RendererName;
    source: "example" | "local" | "env";
  }>;
}

type ProfileSource = "example" | "local" | "env";

function stripComment(value: string): string {
  const hashIndex = value.indexOf(" #");
  return hashIndex === -1 ? value : value.slice(0, hashIndex);
}

function cleanValue(value: string): string {
  return stripComment(value).trim().replace(/^["']|["']$/g, "");
}

function isRenderer(value: string): value is RendererName {
  return value === "fake" || value === "voicelayer-qwen3" || value === "external-command";
}

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function setField(profile: NarrationProfile, section: string | null, key: string, value: string) {
  if (!section) {
    if (key === "id") {
      profile.id = value;
    } else if (key === "name") {
      profile.name = value;
    } else if (key === "renderer" && isRenderer(value)) {
      profile.renderer = value;
    }
    return;
  }

  if (section === "voice_profile" && key === "id") {
    profile.voice_profile_id = value;
    return;
  }

  if (section === "render") {
    profile.render[key] = value;
  }
}

export function parseProfilesYaml(content: string, sourcePath?: string): NarrationProfile[] {
  const profiles: NarrationProfile[] = [];
  let current: NarrationProfile | null = null;
  let section: string | null = null;
  let arrayKey: string | null = null;

  function flushCurrent() {
    if (current?.id) {
      profiles.push(current);
    }
  }

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#") || rawLine.trim() === "profiles:") {
      continue;
    }

    const itemMatch = rawLine.match(/^\s*-\s+id:\s*(.+)$/);
    if (itemMatch) {
      flushCurrent();
      current = {
        id: cleanValue(itemMatch[1]),
        render: {},
        source_path: sourcePath,
      };
      section = null;
      arrayKey = null;
      continue;
    }

    if (!current) {
      continue;
    }

    const trimmed = rawLine.trim();
    if (section === "render" && arrayKey && trimmed.startsWith("- ")) {
      const existing = current.render[arrayKey];
      const next = cleanValue(trimmed.slice(2));
      current.render[arrayKey] = Array.isArray(existing) ? [...existing, next] : [next];
      continue;
    }

    const keyValueMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (section === "render" && keyValueMatch) {
      const [, key, rawValue] = keyValueMatch;
      const value = cleanValue(rawValue);
      if (value === "") {
        arrayKey = key;
        current.render[key] = [];
        continue;
      }
      arrayKey = null;
      setField(current, section, key, value);
      continue;
    }

    const sectionMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      arrayKey = null;
      continue;
    }

    if (!keyValueMatch) {
      continue;
    }

    const [, key, rawValue] = keyValueMatch;
    const value = cleanValue(rawValue);
    if (section === "render" && value === "") {
      arrayKey = key;
      current.render[key] = [];
      continue;
    }
    arrayKey = null;
    setField(current, section, key, value);
  }

  flushCurrent();
  return profiles;
}

async function fileExists(pathName: string): Promise<boolean> {
  try {
    await access(pathName, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function configuredProfileFiles(cwd = process.cwd()): Array<{ pathName: string; source: ProfileSource }> {
  const files: Array<{ pathName: string; source: ProfileSource }> = [
    { pathName: path.join(cwd, "profiles.example.yaml"), source: "example" },
    { pathName: path.join(cwd, "profiles.local.yaml"), source: "local" },
  ];
  const envFiles = process.env.NARRATIONLAYER_PROFILES_FILE;
  if (envFiles) {
    for (const filePath of envFiles.split(path.delimiter).map((item) => item.trim()).filter(Boolean)) {
      files.push({ pathName: path.resolve(filePath), source: "env" });
    }
  }
  return files;
}

export async function loadProfiles(cwd = process.cwd()): Promise<NarrationProfile[]> {
  const loaded = new Map<string, NarrationProfile>();
  for (const candidate of configuredProfileFiles(cwd)) {
    if (!(await fileExists(candidate.pathName))) {
      continue;
    }
    const raw = await readFile(candidate.pathName, "utf8");
    for (const profile of parseProfilesYaml(raw, candidate.pathName)) {
      loaded.set(profile.id, profile);
    }
  }
  return Array.from(loaded.values());
}

export async function getProfileSummary(cwd = process.cwd()): Promise<ProfileSummary> {
  const files: string[] = [];
  const profiles: ProfileSummary["profiles"] = [];
  for (const candidate of configuredProfileFiles(cwd)) {
    if (!(await fileExists(candidate.pathName))) {
      continue;
    }
    files.push(candidate.pathName);
    const raw = await readFile(candidate.pathName, "utf8");
    for (const profile of parseProfilesYaml(raw, candidate.pathName)) {
      profiles.push({
        id: profile.id,
        renderer: profile.renderer,
        source: candidate.source,
      });
    }
  }
  return { files, profiles };
}

export async function findProfile(profileId: string, cwd = process.cwd()): Promise<NarrationProfile | undefined> {
  const profiles = await loadProfiles(cwd);
  return profiles.find((profile) => profile.id === profileId || profile.voice_profile_id === profileId);
}

export function qwenConfigFromProfile(profile: NarrationProfile | undefined): Partial<VoiceLayerQwen3Config> {
  if (!profile) {
    return {};
  }
  const resolveProfilePath = (value: string | undefined): string | undefined => {
    if (!value || value.startsWith("~/") || path.isAbsolute(value) || !profile.source_path) {
      return value;
    }
    return path.resolve(path.dirname(profile.source_path), value);
  };
  return {
    daemon_url: typeof profile.render.daemon_url === "string" ? profile.render.daemon_url : undefined,
    timeout_ms: parsePositiveNumber(profile.render.timeout_ms),
    auth_token_file:
      typeof profile.render.auth_token_file === "string" ? resolveProfilePath(profile.render.auth_token_file) : undefined,
    reference_clip:
      typeof profile.render.reference_clip === "string" ? resolveProfilePath(profile.render.reference_clip) : undefined,
    reference_text: typeof profile.render.reference_text === "string" ? profile.render.reference_text : undefined,
    reference_text_path:
      typeof profile.render.reference_text_path === "string"
        ? resolveProfilePath(profile.render.reference_text_path)
        : undefined,
    reference_clips: Array.isArray(profile.render.reference_clips)
      ? profile.render.reference_clips.map(resolveProfilePath).filter((value): value is string => Boolean(value))
      : typeof profile.render.reference_clips === "string"
        ? [resolveProfilePath(profile.render.reference_clips)].filter((value): value is string => Boolean(value))
        : undefined,
    lora_adapter_path:
      typeof profile.render.lora_adapter_path === "string"
        ? resolveProfilePath(profile.render.lora_adapter_path)
        : undefined,
    lora_scale: parsePositiveNumber(profile.render.lora_scale),
    timing_backend:
      profile.render.timing_backend === "whisper-cli" || profile.render.timing_backend === "none"
        ? profile.render.timing_backend
        : undefined,
    pause_strategy:
      profile.render.pause_strategy === "punctuation" || profile.render.pause_strategy === "none"
        ? profile.render.pause_strategy
        : undefined,
    max_utterance_words: parsePositiveNumber(profile.render.max_utterance_words),
    min_utterance_words: parsePositiveNumber(profile.render.min_utterance_words),
    sentence_pause_seconds: parsePositiveNumber(profile.render.sentence_pause_seconds),
    comma_pause_seconds: parsePositiveNumber(profile.render.comma_pause_seconds),
    trim_silence: parseBoolean(profile.render.trim_silence),
    silence_threshold_db: parseNumber(profile.render.silence_threshold_db),
    eq_highshelf_hz: parseNumber(profile.render.eq_highshelf_hz),
    eq_highshelf_gain_db: parseNumber(profile.render.eq_highshelf_gain_db),
    loudness_target_db: parseNumber(profile.render.loudness_target_db),
    atempo: parsePositiveNumber(profile.render.atempo),
    silence_padding_seconds: parsePositiveNumber(profile.render.silence_padding_seconds),
    repair_word_timings: parseBoolean(profile.render.repair_word_timings),
    max_chunk_duration_seconds: parsePositiveNumber(profile.render.max_chunk_duration_seconds),
    max_chunk_seconds_per_word: parsePositiveNumber(profile.render.max_chunk_seconds_per_word),
    max_chunk_retries: parsePositiveNumber(profile.render.max_chunk_retries),
    whisper_binary:
      typeof profile.render.whisper_binary === "string" ? resolveProfilePath(profile.render.whisper_binary) : undefined,
    whisper_model:
      typeof profile.render.whisper_model === "string" ? resolveProfilePath(profile.render.whisper_model) : undefined,
  };
}

export function externalCommandConfigFromProfile(profile: NarrationProfile | undefined): Partial<ExternalCommandConfig> {
  if (!profile) {
    return {};
  }
  const resolveProfilePath = (value: string | undefined): string | undefined => {
    if (!value || value.startsWith("~/") || path.isAbsolute(value) || !profile.source_path) {
      return value;
    }
    return path.resolve(path.dirname(profile.source_path), value);
  };
  const args = Array.isArray(profile.render.args)
    ? profile.render.args
    : typeof profile.render.args === "string"
      ? [profile.render.args]
      : undefined;
  return {
    command: typeof profile.render.command === "string" ? profile.render.command : undefined,
    args,
    cwd: typeof profile.render.cwd === "string" ? resolveProfilePath(profile.render.cwd) : undefined,
    timeout_ms: parsePositiveNumber(profile.render.timeout_ms),
    output_ext: typeof profile.render.output_ext === "string" ? profile.render.output_ext : undefined,
    reference_clip:
      typeof profile.render.reference_clip === "string" ? resolveProfilePath(profile.render.reference_clip) : undefined,
    reference_text: typeof profile.render.reference_text === "string" ? profile.render.reference_text : undefined,
    reference_text_path:
      typeof profile.render.reference_text_path === "string"
        ? resolveProfilePath(profile.render.reference_text_path)
        : undefined,
    timing_backend:
      profile.render.timing_backend === "estimated" || profile.render.timing_backend === "none"
        ? profile.render.timing_backend
        : undefined,
  };
}

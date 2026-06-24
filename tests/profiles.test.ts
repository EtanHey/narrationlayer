import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { externalCommandConfigFromProfile, findProfile, parseProfilesYaml, qwenConfigFromProfile } from "../src/profiles.js";
import { createJobFromPayload, getRendererConfigForVoiceProfile } from "../src/service.js";

function createTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "narrationlayer-profiles-"));
}

test("local profile overlay can select a local renderer without hardcoding profile names", async () => {
  const dataDir = createTempDir();
  const profileDir = createTempDir();
  const previousProfilesFile = process.env.NARRATIONLAYER_PROFILES_FILE;
  const previousDataDir = process.env.NARRATIONLAYER_DATA_DIR;
  const profilesPath = path.join(profileDir, "profiles.local.yaml");
  writeFileSync(
    profilesPath,
    `profiles:
  - id: local-reader
    name: Local Reader
    renderer: voicelayer-qwen3
    voice_profile:
      id: local-reader
    render:
      daemon_url: http://127.0.0.1:8880
      timeout_ms: 120000
      timing_backend: whisper-cli
      pause_strategy: punctuation
      max_utterance_words: 14
      min_utterance_words: 3
      sentence_pause_seconds: 0.65
      comma_pause_seconds: 0.25
      trim_silence: true
      silence_threshold_db: -45
      silence_padding_seconds: 0.08
      repair_word_timings: true
      max_chunk_duration_seconds: 45
      max_chunk_seconds_per_word: 3
      max_chunk_retries: 1
      reference_clip: /tmp/local-reference.wav
      reference_text: local reference text
`,
  );
  process.env.NARRATIONLAYER_PROFILES_FILE = profilesPath;
  process.env.NARRATIONLAYER_DATA_DIR = dataDir;

  try {
    const created = await createJobFromPayload({
      job_id: "local-profile-job",
      voice_profile: "local-reader",
      segments: [{ id: "seg-1", title: "Intro", script: "Hello" }],
    });
    const job = JSON.parse(await Bun.file(created.job_path).text());
    expect(job.renderer).toBe("voicelayer-qwen3");

    expect((await getRendererConfigForVoiceProfile("local-reader")).qwen).toMatchObject({
      daemon_url: "http://127.0.0.1:8880",
      timeout_ms: 120000,
      timing_backend: "whisper-cli",
      pause_strategy: "punctuation",
      max_utterance_words: 14,
      min_utterance_words: 3,
      sentence_pause_seconds: 0.65,
      comma_pause_seconds: 0.25,
      trim_silence: true,
      silence_threshold_db: -45,
      silence_padding_seconds: 0.08,
      repair_word_timings: true,
      max_chunk_duration_seconds: 45,
      max_chunk_seconds_per_word: 3,
      max_chunk_retries: 1,
      reference_clip: "/tmp/local-reference.wav",
      reference_text: "local reference text",
    });
  } finally {
    if (previousProfilesFile === undefined) {
      delete process.env.NARRATIONLAYER_PROFILES_FILE;
    } else {
      process.env.NARRATIONLAYER_PROFILES_FILE = previousProfilesFile;
    }
    if (previousDataDir === undefined) {
      delete process.env.NARRATIONLAYER_DATA_DIR;
    } else {
      process.env.NARRATIONLAYER_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("profile parser keeps render list values inside the render section", () => {
  const profiles = parseProfilesYaml(`profiles:
  - id: command-reader
    renderer: external-command
    voice_profile:
      id: command-reader
    render:
      command: /usr/bin/python
      args:
        - -m
        - local.runner
        - "{script}"
      output_ext: wav
`);

  expect(externalCommandConfigFromProfile(profiles[0])).toMatchObject({
    command: "/usr/bin/python",
    args: ["-m", "local.runner", "{script}"],
    output_ext: "wav",
  });
});

test("Qwen3 profiles can configure a private LoRA adapter path and inference scale", () => {
  const profiles = parseProfilesYaml(`profiles:
  - id: qwen3-lora-reader
    renderer: voicelayer-qwen3
    voice_profile:
      id: qwen3-lora-reader
    render:
      daemon_url: http://127.0.0.1:8880
      reference_clip: voices/ref.wav
      reference_text: local reference text
      lora_adapter_path: private-adapters/theo-qwen3/checkpoint-epoch-10
      lora_scale: 0.3
`, "/tmp/profiles/profiles.local.yaml");

  expect(qwenConfigFromProfile(profiles[0])).toMatchObject({
    reference_clip: "/tmp/profiles/voices/ref.wav",
    reference_text: "local reference text",
    lora_adapter_path: "/tmp/profiles/private-adapters/theo-qwen3/checkpoint-epoch-10",
    lora_scale: 0.3,
  });
});

test("speaker aliases resolve to the latest accepted canonical profile", async () => {
  const dataDir = createTempDir();
  const profileDir = createTempDir();
  const previousProfilesFile = process.env.NARRATIONLAYER_PROFILES_FILE;
  const previousDataDir = process.env.NARRATIONLAYER_DATA_DIR;
  const profilesPath = path.join(profileDir, "profiles.local.yaml");
  writeFileSync(
    profilesPath,
    `profiles:
  - id: theo-c4
    renderer: voicelayer-qwen3
    speaker: theo
    profile_version: c4
    accepted: false
    superseded_by: theo-c4s
    aliases:
      - theo
    voice_profile:
      id: theo-c4
    render:
      reference_clip: /tmp/theo-c4.wav
      reference_text: muffled
      model: qwen3-tts-4bit
  - id: theo-c4s
    renderer: voicelayer-qwen3
    speaker: theo
    profile_version: c4s
    accepted: true
    aliases:
      - theo
    voice_profile:
      id: theo-c4s
    render:
      reference_clip: /tmp/theo-c4s.wav
      reference_text: bright
      model: qwen3-tts-4bit
`,
  );
  process.env.NARRATIONLAYER_PROFILES_FILE = profilesPath;
  process.env.NARRATIONLAYER_DATA_DIR = dataDir;

  try {
    const profile = await findProfile("theo");
    expect(profile?.id).toBe("theo-c4s");

    const created = await createJobFromPayload({
      job_id: "alias-job",
      voice_profile: "theo",
      segments: [{ id: "seg-1", title: "Intro", script: "Hello" }],
    });
    const job = JSON.parse(await Bun.file(created.job_path).text());
    expect(job.voice_profile).toBe("theo-c4s");
    expect(job.renderer).toBe("voicelayer-qwen3");

    const explicitRenderer = await createJobFromPayload({
      job_id: "alias-explicit-renderer-job",
      voice_profile: "theo",
      renderer: "fake",
      segments: [{ id: "seg-1", title: "Intro", script: "Hello" }],
    });
    const explicitJob = JSON.parse(await Bun.file(explicitRenderer.job_path).text());
    expect(explicitJob.voice_profile).toBe("theo-c4s");
    expect(explicitJob.renderer).toBe("fake");
  } finally {
    if (previousProfilesFile === undefined) {
      delete process.env.NARRATIONLAYER_PROFILES_FILE;
    } else {
      process.env.NARRATIONLAYER_PROFILES_FILE = previousProfilesFile;
    }
    if (previousDataDir === undefined) {
      delete process.env.NARRATIONLAYER_DATA_DIR;
    } else {
      process.env.NARRATIONLAYER_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("Qwen3 profiles surface voice-SSOT provenance fields", () => {
  const profiles = parseProfilesYaml(`profiles:
  - id: theo-c4s
    renderer: voicelayer-qwen3
    speaker: theo
    profile_version: c4s
    accepted: true
    reference_clip_sha: abc123
    voice_profile:
      id: theo-c4s
    render:
      reference_clip: voices/theo-c4s.wav
      reference_text: bright reference text
      model: qwen3-tts-4bit
`, "/tmp/profiles/profiles.local.yaml");

  expect(qwenConfigFromProfile(profiles[0])).toMatchObject({
    profile_id: "theo-c4s",
    profile_version: "c4s",
    reference_clip_sha: "abc123",
    model: "qwen3-tts-4bit",
  });
});
